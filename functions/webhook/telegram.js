import { handleTelegramMessage } from './telegramMessageHandler.js';
import { getDatabase } from '../utils/databaseAdapter.js';

// 内存级常驻单例缓存（Module Scope Cache），消灭每次 Webhook 调用的 D1 配置读取延迟
let cachedWebhookConfig = null;
let cachedConfigTime = 0;
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟有效

async function getCachedWebhookConfig(db) {
    const now = Date.now();
    if (cachedWebhookConfig && (now - cachedConfigTime < CONFIG_CACHE_TTL_MS)) {
        return cachedWebhookConfig;
    }

    const raw = await db.get('manage@sysConfig@telegram@webhook');
    if (!raw) return null;

    try {
        cachedWebhookConfig = JSON.parse(raw);
        cachedConfigTime = now;
        return cachedWebhookConfig;
    } catch (_) {
        return null;
    }
}

/**
 * Telegram Webhook 端点
 * 收到 Webhook 校验后秒级返回 200 OK，解除 Telegram 服务器的推送堵塞，
 * 使一次性转发的组图能瞬间无阻碍并发推达。
 */
export async function onRequest(context) {
    const { request, env } = context;

    // 只接受 POST 请求
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        const db = getDatabase(env);
        // 从内存直取配置（0ms）
        const config = await getCachedWebhookConfig(db);

        if (!config) {
            return new Response('Webhook not configured', { status: 400 });
        }

        if (!config.enabled) {
            return new Response('Webhook disabled', { status: 403 });
        }

        // 验证 secret_token
        const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (!secretToken || secretToken !== config.secretToken) {
            console.error('[TelegramWebhook] Invalid secret token');
            return new Response('Unauthorized', { status: 401 });
        }

        // 解析 Update 对象
        const update = await request.json();

        // 将具体图片入库、去重、索引同步放入后台执行，主线程秒回 200 解锁 Telegram 队列
        const { waitUntil } = context;
        const task = handleTelegramMessage(context, update, config).catch(err => {
            console.error('[TelegramWebhook] Background task error:', err);
        });

        if (typeof waitUntil === 'function') {
            waitUntil(task);
        } else if (typeof context.waitUntil === 'function') {
            context.waitUntil(task);
        } else {
            await task;
        }

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('[TelegramWebhook] Error:', error);
        return new Response(JSON.stringify({ ok: true, error: 'Internal error' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
