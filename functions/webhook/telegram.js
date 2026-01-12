import { handleTelegramMessage } from './telegramMessageHandler.js';
import { getDatabase } from '../utils/databaseAdapter.js';

/**
 * Telegram Webhook 端点
 * 接收 Telegram Bot 发送的 Update 对象
 */
export async function onRequest(context) {
    const { request, env } = context;

    // 只接受 POST 请求
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        // 获取 Webhook 配置
        const db = getDatabase(env);
        const webhookConfig = await db.get('manage@sysConfig@telegram@webhook');

        if (!webhookConfig) {
            return new Response('Webhook not configured', { status: 400 });
        }

        const config = JSON.parse(webhookConfig);

        // 检查 Webhook 是否启用
        if (!config.enabled) {
            return new Response('Webhook disabled', { status: 403 });
        }

        // 验证 secret_token
        const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (!secretToken || secretToken !== config.secretToken) {
            console.error('Invalid secret token');
            return new Response('Unauthorized', { status: 401 });
        }

        // 解析 Update 对象
        const update = await request.json();

        // 处理消息
        const result = await handleTelegramMessage(context, update);

        if (result.success) {
            return new Response(JSON.stringify({
                ok: true,
                fileId: result.fileId
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            // 即使处理失败，也返回 200 避免 Telegram 重试
            console.log('Message not processed:', result.reason);
            return new Response(JSON.stringify({
                ok: true,
                skipped: true,
                reason: result.reason
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch (error) {
        console.error('Webhook error:', error);
        // 返回 200 避免 Telegram 重试
        return new Response(JSON.stringify({
            ok: true,
            error: 'Internal error'
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
