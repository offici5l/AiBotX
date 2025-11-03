import { Telegraf } from 'telegraf';
import axios from 'axios';
import { Buffer } from 'buffer';
import Redis from 'ioredis';

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const REDIS_URL = process.env.REDIS_URL;
const HF_TOKEN = process.env.HF_TOKEN;

const SPECIAL_ANONYMOUS_IDS = [1087968824, 136817688];

const PROMPT_TEMPLATE = 'You are a strict Telegram group moderator. Your task is to analyze user messages or images for violations of the EXACT group rules listed below. ONLY consider these rules: {RULES}. Do not add, assume, or reference any other rules from your training data or external knowledge. First, verify step-by-step: 1) List each rule briefly. 2) Check if the content matches any rule exactly. 3) Decide YES only if there is a direct violation. Respond only with "YES" if the message/image violates any rule, followed by a brief explanation on a new line (reference the specific rule violated). Respond with "NO" if it does not violate any rules, followed by a brief reason on a new line. Keep responses concise. Do not repeat or quote the message/image content in your explanation to avoid re-sharing sensitive material.';

const VLM_CONFIG = {
  ENDPOINT: 'https://router.huggingface.co/v1/chat/completions',
  MODEL: 'Qwen/Qwen2.5-VL-7B-Instruct',
  HF_TOKEN: HF_TOKEN,
  MAX_TOKENS: 150
};

if (!BOT_TOKEN || !VLM_CONFIG.HF_TOKEN || !REDIS_URL || !WEBHOOK_URL) {
  process.exit(1);
}

const redis = new Redis(REDIS_URL);
redis.on('error', (err) => {});

const bot = new Telegraf(BOT_TOKEN);

const callHuggingFace = async (messages) => {
  try {
    const { data } = await axios.post(VLM_CONFIG.ENDPOINT, {
      model: VLM_CONFIG.MODEL,
      messages,
      max_tokens: VLM_CONFIG.MAX_TOKENS,
      temperature: 0
    }, {
      headers: { Authorization: `Bearer ${VLM_CONFIG.HF_TOKEN}` },
      timeout: 10000
    });

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { violates: false, reason: 'No analysis response' };

    const parts = content.split('\n').map(p => p.trim()).filter(Boolean);
    const decision = parts[0]?.toUpperCase();
    const reason = parts.slice(1).join(' ') || 'Unspecified';

    return {
      violates: decision === 'YES',
      reason: reason
    };
  } catch (error) {
    return { violates: false, reason: 'Analysis unavailable' };
  }
};

const getSimpleRules = async (chatId) => {
  try {
    const simpleRules = await redis.get(`group_simple_rules:${chatId}`);
    return simpleRules ? simpleRules : null;
  } catch (error) {
    return null;
  }
};

const getRulesCreatedDate = async (chatId) => {
  try {
    const createdDate = await redis.get(`group_rules_created:${chatId}`);
    return createdDate ? parseInt(createdDate, 10) : null;
  } catch (error) {
    return null;
  }
};

const buildFullPrompt = (rules) => {
  return PROMPT_TEMPLATE.replace('{RULES}', rules.trim());
};

const setCustomRules = async (chatId, rules) => {
  try {
    if (rules.length < 20) throw new Error('Rules must be at least 20 characters long');
    const nowInSeconds = Math.floor(Date.now() / 1000);
    await redis.set(`group_simple_rules:${chatId}`, rules.trim());
    await redis.set(`group_rules_created:${chatId}`, nowInSeconds.toString());
    return buildFullPrompt(rules);
  } catch (error) {
    return false;
  }
};

const isAuthorizedUser = async (ctx, chatId) => {
  const userId = ctx.from.id;
  if (SPECIAL_ANONYMOUS_IDS.includes(userId)) return true;
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch (error) {
    return false;
  }
};

const HELP_TEXT = `
🤖 AI Moderator Bot (Beta)
📎 Repo: github.com/offici5l/AiBotX

🧰 Commands:

• /help /bot /start
Show this menu.

• /rules set <rules>  
Set group rules (admins only).  
Example: /rules set No spam - No links - Tech only

• /rules reset  
Delete current rules.

• /report  
↪️ Reply to any violating message or image with /report.

• /unmute <user_id>  
Unmute a muted user (admins only).  
Example: /unmute 123456789

🌐 Website: offici5l.github.io
`;

bot.command('help', async (ctx) => ctx.reply(HELP_TEXT));

bot.command('rules', async (ctx) => {
  if (ctx.chat.type !== 'supergroup') return ctx.reply('This command is for groups only.');
  const chatId = ctx.chat.id;
  const args = ctx.message.text.replace('/rules', '').trim().split(' ');
  const subcommand = args[0]?.toLowerCase();
  if (!subcommand) {
    const simpleRules = await getSimpleRules(chatId);
    if (!simpleRules) return ctx.reply('❌ No custom rules set for this group. Use /rules set <rules> to add them.');
    return ctx.reply(`Current rules:\n\n"${simpleRules}"`);
  }
  const authorized = await isAuthorizedUser(ctx, chatId);
  if (!authorized && (subcommand === 'set' || subcommand === 'reset')) return ctx.reply('Only admins or authorized special users can set or reset rules.');
  if (subcommand === 'set') {
    const rulesText = args.slice(1).join(' ').trim();
    if (!rulesText) return ctx.reply('Usage: /rules set <simple rules here>\nExample: /rules set no spam, no ads, no hate speech, no off-topic (keep it tech-related).');
    const fullPrompt = await setCustomRules(chatId, rulesText);
    if (fullPrompt !== false) {
      await ctx.reply(`✅ Custom rules set: "${rulesText}"\n\n(Full prompt built internally for analysis.)\n\nNow /report will work.`);
    } else {
      await ctx.reply('❌ Failed to set rules. Check length (min 20 chars) and try again.');
    }
    return;
  }
  if (subcommand === 'reset') {
    try {
      await redis.del(`group_simple_rules:${chatId}`);
      await redis.del(`group_rules_created:${chatId}`);
      await ctx.reply('🗑️ Custom rules reset. Use /rules set <rules> to add new ones.');
    } catch (error) {
      await ctx.reply('❌ Failed to reset rules. Try again.');
    }
    return;
  }
  await ctx.reply('Invalid subcommand. Use: /rules (show), /rules set <rules>, or /rules reset.');
});

bot.command('unmute', async (ctx) => {
  if (ctx.chat.type !== 'supergroup') return ctx.reply('This command is for groups only.');
  const chatId = ctx.chat.id;
  const args = ctx.message.text.replace('/unmute', '').trim().split(' ');
  const userIdStr = args[0]?.trim();
  if (!userIdStr || isNaN(parseInt(userIdStr))) return ctx.reply('Usage: /unmute <user_id>\nExample: /unmute 123456789\n(Only admins can use this.)');
  const userId = parseInt(userIdStr);
  const authorized = await isAuthorizedUser(ctx, chatId);
  if (!authorized) return ctx.reply('Only admins or authorized special users can unmute users.');
  try {
    await ctx.telegram.restrictChatMember(chatId, userId, {
      until_date: false,
      permissions: {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_manage_topics: true
      }
    });
    let userDisplay = `User ID: ${userId}`;
    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      if (member.user.username) userDisplay = `@${member.user.username} (ID: ${userId})`;
      else if (member.user.first_name) userDisplay = `${member.user.first_name} (ID: ${userId})`;
    } catch (error) {}
    await ctx.reply(`✅ ${userDisplay} unmuted successfully.`);
  } catch (error) {
    await ctx.reply(`❌ Failed to unmute user ${userId}. Check bot permissions or if the user exists.`);
  }
});

bot.command('report', async (ctx) => {
  if (ctx.chat.type !== 'supergroup') return ctx.reply('This command is for groups only.');
  const replied = ctx.message.reply_to_message;
  if (!replied) return ctx.reply('Please reply to a message with /report to analyze it for rule violations.');
  const { from: { id: userId, first_name, username }, message_id: messageId, text, caption, photo, reply_markup, date: messageDate } = replied;
  const chatId = ctx.chat.id;
  const messageText = text || caption || '';
  if (!messageText && !photo) return ctx.reply('The replied message has no text or photo to analyze.');
  const userDisplay = username ? `@${username}` : first_name || 'Unknown User';
  const userInfo = `${userDisplay} (ID: ${userId})`;
  let isReportedUserAuthorized = SPECIAL_ANONYMOUS_IDS.includes(userId);
  if (!isReportedUserAuthorized) {
    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      isReportedUserAuthorized = ['administrator', 'creator'].includes(member.status);
    } catch (error) {
      isReportedUserAuthorized = false;
    }
  }
  if (isReportedUserAuthorized) return ctx.reply(`ℹ️ This user (${userInfo}) is an admin or authorized special user. Moderation actions skipped.`);

  let markupText = '';
  if (reply_markup && reply_markup.inline_keyboard && Array.isArray(reply_markup.inline_keyboard)) {
    const buttons = [];
    reply_markup.inline_keyboard.forEach(row => {
      if (Array.isArray(row)) {
        row.forEach(button => {
          if (button && button.text) {
            buttons.push(button.text);
          }
        });
      }
    });
    if (buttons.length > 0) {
      markupText = ` The message includes inline keyboard buttons with the following texts: "${buttons.join('", "')}".`;
    }
  }

  const loadingMsg = await ctx.reply('🔍 Analyzing content...');
  let { violates, reason } = { violates: false, reason: '' };
  try {
    const simpleRules = await getSimpleRules(chatId);
    if (!simpleRules) {
      await bot.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, '❌ No custom rules set for this group. Admins, use /rules set first.');
      return;
    }
    const rulesCreatedDate = await getRulesCreatedDate(chatId);
    if (rulesCreatedDate && messageDate < rulesCreatedDate) {
      await bot.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, '❌ This message was sent before the rules were created. Cannot check violations for old messages.');
      return;
    }
    const fullPrompt = buildFullPrompt(simpleRules);
    const systemMsg = { role: 'system', content: fullPrompt };

    let userMsg;
    let analysisText = `Analyze this message for rule violations: "${messageText}"${markupText}`;
    if (photo) {
      const file = await bot.telegram.getFile(photo[photo.length - 1].file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const { data } = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const imageAnalysisText = messageText ? `${analysisText} (The text is the image caption.)` : `Analyze this image for rule violations.${markupText}`;
      userMsg = {
        role: 'user',
        content: [
          { type: 'text', text: imageAnalysisText },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}` } }
        ]
      };
    } else {
      userMsg = { role: 'user', content: analysisText };
    }

    ({ violates, reason } = await callHuggingFace([systemMsg, userMsg]));
  } catch (error) {
    await bot.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, '❌ Analysis failed. Check rules or try again.');
    return;
  }
  const response = violates ? `⚠️ Violation detected: ${reason}` : `✅ All good: ${reason}`;
  await bot.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, response);
  if (violates) {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
      const untilDate = 0;
      await bot.telegram.restrictChatMember(chatId, userId, {
        until_date: untilDate,
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false
        }
      });
      await ctx.reply(`User ${userInfo} muted permanently: ${reason}\n\n(Admins can use /unmute ${userId} to unmute.)`);
    } catch (error) {
      await ctx.reply(`Violation detected for ${userInfo}, but action failed (e.g., admin rights needed). Reason: ${reason}`);
    }
  }
});

export default async (req, res) => {
  if (req.query.set_webhook) {
    try {
      await bot.telegram.setWebhook(WEBHOOK_URL);
      return res.status(200).json({ message: 'Webhook set' });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to set webhook' });
    }
  }
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body, res);
      return;
    } catch (error) {
      return res.status(500).json({ error: 'Update handling failed' });
    }
  }
  if (req.method === 'GET' && req.url === '/') return res.status(200).send('Bot is alive');
  return res.status(404).json({ error: 'Not found' });
};