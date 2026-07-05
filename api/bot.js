const { Telegraf, Markup } = require('telegraf');
const { Redis } = require('@upstash/redis');

// إعداد التليجرام وقاعدة بيانات Redis
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);

// دالة للتحقق من اشتراك المستخدم
async function isPremiumUser(chatId) {
    const expiryDate = await redis.get(`premium_user_${chatId}`);
    if (!expiryDate) return false;
    
    // التحقق مما إذا كان وقت انتهاء الاشتراك أكبر من الوقت الحالي
    const now = new Date().getTime();
    return parseInt(expiryDate) > now;
}

// دالة إرسال الطلب وتشغيل جيت هاب
async function triggerGitHubAction(code, dylibName, chatId) {
    const url = `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}/actions/workflows/build.yml/dispatches`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${process.env.GITHUB_PAT}`,
            'User-Agent': 'Vercel-Bot'
        },
        body: JSON.stringify({
            ref: 'main',
            inputs: {
                code_content: code,
                dylib_name: dylibName,
                chat_id: chatId.toString()
            }
        })
    });

    if (!response.ok) throw new Error("GitHub API Error");
    return true;
}

// ==========================================
// أوامر ولوحة تحكم الآدمن (أزرار تفاعلية)
// ==========================================
bot.command('admin', async (ctx) => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;

    // إنشاء أزرار لوحة التحكم
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('توليد كود (شهر) 🎟️', 'gen_30')],
        [Markup.button.callback('توليد كود (أسبوع) 🎟️', 'gen_7')],
        [Markup.button.callback('توليد كود (يوم واحد للتجربة) ⏱️', 'gen_1')]
    ]);

    await ctx.reply('⚙️ أهلاً بك في لوحة تحكم الإدارة.\nاختر مدة الكود (استخدام واحد فقط):', keyboard);
});

// التعامل مع ضغطات الأزرار من الآدمن
bot.action(/gen_(\d+)/, async (ctx) => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;

    const days = parseInt(ctx.match[1]); // استخراج عدد الأيام من الزر (30, 7, 1)
    const code = 'VIP-' + Math.random().toString(36).substr(2, 8).toUpperCase(); // توليد كود عشوائي

    // حفظ الكود في Redis مع تحديد عدد الأيام كقيمة
    await redis.set(`activation_code_${code}`, days);

    await ctx.reply(`✅ تم توليد كود استخدام واحد بنجاح:\n\n\`${code}\`\n\nالمدة: ${days} يوم.`, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery('تم إنشاء الكود بنجاح'); // إخفاء علامة التحميل من الزر
});

// ==========================================
// أوامر المشتركين والتفعيل
// ==========================================
bot.start((ctx) => {
    ctx.reply("👋 مرحباً بك في بوت تجميع ملفات الـ dylib.\n\n🔑 لتفعيل حسابك، أرسل:\n`/activate كود_التفعيل`", { parse_mode: 'Markdown' });
});

bot.command('activate', async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.message.text.split(' ');
    const codeInput = args[1];

    if (!codeInput) return ctx.reply("⚠️ الرجاء إدخال الكود مع الأمر.\nمثال: `/activate VIP-XXXXX`", { parse_mode: 'Markdown' });

    // 1. البحث عن الكود في قاعدة البيانات
    const days = await redis.get(`activation_code_${codeInput}`);

    if (!days) return ctx.reply("❌ الكود غير صحيح، أو تم استخدامه مسبقاً.");

    // 2. حساب تاريخ الانتهاء بالملي ثانية
    const now = new Date();
    const expiryTimestamp = now.getTime() + (parseInt(days) * 24 * 60 * 60 * 1000);

    // 3. إضافة المستخدم لقائمة البريميوم
    await redis.set(`premium_user_${chatId}`, expiryTimestamp.toString());

    // 4. الأهم: حذف الكود فوراً لضمان (استخدام واحد فقط)
    await redis.del(`activation_code_${codeInput}`);

    const expiryDate = new Date(expiryTimestamp);
    ctx.reply(`🎉 تم تفعيل اشتراكك بنجاح لمدة ${days} يوم!\n📅 ينتهي الاشتراك في: ${expiryDate.toLocaleDateString()}`);
});

// ==========================================
// استقبال الأكواد وإرسالها لـ GitHub
// ==========================================
bot.on(['text', 'document'], async (ctx) => {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    // تجاوز أوامر البوت الأساسية
    if (ctx.message.text && ctx.message.text.startsWith('/')) return;

    // فحص الاشتراك
    const hasAccess = await isPremiumUser(chatId);
    if (!hasAccess) {
        return ctx.reply("🔒 عذراً، هذا البوت خاص بالمشتركين فقط.\nاستخدم أمر /activate متبوعاً بكودك الخاص لتفعيل البوت.");
    }

    let codeContent = "";
    let isCodeInput = false;

    // استخراج الكود من رسالة نصية أو ملف
    if (ctx.message.text && (ctx.message.text.includes('#import') || ctx.message.text.includes('%hook'))) {
        codeContent = ctx.message.text;
        isCodeInput = true;
    } else if (ctx.message.document) {
        const doc = ctx.message.document;
        if (doc.file_name.endsWith('.m') || doc.file_name.endsWith('.mm') || doc.file_name.endsWith('.txt')) {
            isCodeInput = true;
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const response = await fetch(fileLink.href);
            codeContent = await response.text();
        }
    }

    // إذا تم إرسال كود برمجي
    if (isCodeInput) {
        try { await ctx.deleteMessage(messageId); } catch (e) { } // حذف الرسالة للسرية
        
        // حفظ الكود مؤقتاً في Redis
        await redis.set(`session_code_${chatId}`, codeContent, { ex: 600 });
        return ctx.reply("📥 تم استلام الكود وحذفه فوراً لحمايتك 🔒.\nأرسل الآن اسم ملف الـ dylib الناتج (مثال: `MyTweak`):", { parse_mode: 'Markdown' });
    }

    // إذا أرسل المستخدم نصاً عادياً (نعتبره اسم الدايلب)
    if (ctx.message.text) {
        const savedCode = await redis.get(`session_code_${chatId}`);
        if (savedCode) {
            const dylibName = ctx.message.text.replace(/[^a-zA-Z0-9_-]/g, '');
            if (!dylibName) return ctx.reply("❌ اسم الملف غير صالح.");

            await ctx.reply(`⚙️ جاري تشغيل سيرفرات GitHub لبناء \`${dylibName}.dylib\`...`, { parse_mode: 'Markdown' });

            try {
                await triggerGitHubAction(savedCode, dylibName, chatId);
                await redis.del(`session_code_${chatId}`); // تنظيف الجلسة
            } catch (error) {
                ctx.reply("❌ حدث خطأ أثناء الاتصال بسيرفر البناء.");
            }
        }
    }
});

// تشغيل الـ Webhook
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        await bot.handleUpdate(req.body, res);
    }
    res.status(200).send('OK');
};
