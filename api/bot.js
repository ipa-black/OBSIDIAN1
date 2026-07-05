const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);

// ==========================================
// 🧠 الذاكرة العشوائية (In-Memory Storage)
// ==========================================
const sessions = new Map();        // لحفظ الأكواد المحذوفة مؤقتاً
const activationCodes = new Map(); // لحفظ أكواد التفعيل
const premiumUsers = new Map();    // لحفظ المشتركين

// ==========================================
// 📡 دالة الاتصال بجيت هاب (محدثة لكشف الأخطاء)
// ==========================================
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
            ref: 'main', // ⚠️ تأكد أن الفرع الأساسي في جيت هاب اسمه main وليس master
            inputs: {
                code_content: code,
                dylib_name: dylibName,
                chat_id: chatId.toString()
            }
        })
    });

    if (!response.ok) {
        // سحب رسالة الخطأ الحقيقية من جيت هاب وتمريرها للبوت
        const errText = await response.text();
        throw new Error(`Code: ${response.status} - Details: ${errText}`);
    }
    return true;
}

// ==========================================
// ⚙️ أوامر الآدمن (لوحة التحكم لتوليد الأكواد)
// ==========================================
bot.command('admin', async (ctx) => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('توليد كود (شهر) 🎟️', 'gen_30')],
        [Markup.button.callback('توليد كود (أسبوع) 🎟️', 'gen_7')],
        [Markup.button.callback('توليد كود (يوم واحد) ⏱️', 'gen_1')]
    ]);

    await ctx.reply('⚙️ أهلاً بك في لوحة تحكم الإدارة.\nاختر مدة الكود (استخدام واحد فقط):', keyboard);
});

bot.action(/gen_(\d+)/, async (ctx) => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;

    const days = parseInt(ctx.match[1]);
    const code = 'VIP-' + Math.random().toString(36).substr(2, 8).toUpperCase();

    // حفظ الكود
    activationCodes.set(code, days);

    await ctx.reply(`✅ تم توليد كود استخدام واحد بنجاح:\n\n\`${code}\`\n\nالمدة: ${days} يوم.`, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery('تم إنشاء الكود بنجاح');
});

// ==========================================
// 🔓 أوامر المشتركين والتفعيل
// ==========================================
bot.start((ctx) => {
    ctx.reply("👋 مرحباً بك في بوت تجميع ملفات الـ dylib.\n\n🔑 لتفعيل حسابك، أرسل:\n`/activate كود_التفعيل`", { parse_mode: 'Markdown' });
});

bot.command('activate', async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.message.text.split(' ');
    const codeInput = args[1];

    if (!codeInput) return ctx.reply("⚠️ الرجاء إدخال الكود مع الأمر.\nمثال: `/activate VIP-XXXXX`", { parse_mode: 'Markdown' });

    if (!activationCodes.has(codeInput)) {
        return ctx.reply("❌ الكود غير صحيح، أو تم استخدامه مسبقاً.");
    }

    const days = activationCodes.get(codeInput);
    const expiryTimestamp = new Date().getTime() + (days * 24 * 60 * 60 * 1000);

    premiumUsers.set(chatId, expiryTimestamp);
    activationCodes.delete(codeInput);

    const expiryDate = new Date(expiryTimestamp);
    ctx.reply(`🎉 تم تفعيل اشتراكك بنجاح لمدة ${days} يوم!\n📅 ينتهي الاشتراك في: ${expiryDate.toLocaleDateString()}`);
});

// ==========================================
// 🚀 استقبال الأكواد وإرسالها لجيت هاب
// ==========================================
bot.on(['text', 'document'], async (ctx) => {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    if (ctx.message.text && ctx.message.text.startsWith('/')) return;

    // فحص الاشتراك
    const userExpiry = premiumUsers.get(chatId);
    const hasAccess = userExpiry && userExpiry > new Date().getTime();

    if (!hasAccess && chatId !== ADMIN_CHAT_ID) {
        return ctx.reply("🔒 عذراً، هذا البوت خاص بالمشتركين فقط.\nاستخدم أمر /activate لتفعيل البوت.");
    }

    let codeContent = "";
    let isCodeInput = false;

    if (ctx.message.text && (ctx.message.text.includes('#import') || ctx.message.text.includes('%hook') || ctx.message.text.includes('@interface'))) {
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

    if (isCodeInput) {
        try { await ctx.deleteMessage(messageId); } catch (e) { } 
        
        sessions.set(chatId, codeContent); 
        return ctx.reply("📥 تم استلام الكود وحذفه فوراً لحمايتك 🔒.\nأرسل الآن اسم ملف الـ dylib الناتج (مثال: `MyTweak`):", { parse_mode: 'Markdown' });
    }

    if (ctx.message.text && sessions.has(chatId)) {
        const savedCode = sessions.get(chatId);
        const dylibName = ctx.message.text.replace(/[^a-zA-Z0-9_-]/g, ''); 
        
        if (!dylibName) return ctx.reply("❌ اسم الملف غير صالح.");

        await ctx.reply(`⚙️ جاري تشغيل سيرفرات GitHub لبناء \`${dylibName}.dylib\`...`, { parse_mode: 'Markdown' });

        try {
            await triggerGitHubAction(savedCode, dylibName, chatId);
            sessions.delete(chatId);
            // إعلام المستخدم بنجاح الإرسال
            ctx.reply("✅ تم قبول الطلب من خوادم GitHub! جاري البناء وسيصلك الملف بعد لحظات 🚀.");
        } catch (error) {
            // 🚨 هنا سيتم طباعة سبب الرفض بالتفصيل من جيت هاب 🚨
            ctx.reply(`❌ تم رفض الطلب من خوادم GitHub!\n\n**السبب التقني:**\n\`${error.message}\`\n\nيرجى مراجعة الخطأ أعلاه لحل المشكلة.`, { parse_mode: 'Markdown' });
        }
    }
});

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        await bot.handleUpdate(req.body, res);
    }
    res.status(200).send('Bot is running...');
};
