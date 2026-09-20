const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const router = express.Router();

const WECHAT_TOKEN = process.env.WECHAT_TOKEN || '';
const COZE_PAT = process.env.COZE_PAT || '';
const COZE_BOT_ID = process.env.COZE_BOT_ID || '';
const COZE_API_BASE = 'https://api.coze.cn';

function checkSignature(signature, timestamp, nonce) {
  const arr = [WECHAT_TOKEN, timestamp, nonce].sort();
  const str = arr.join('');
  const hash = crypto.createHash('sha1').update(str).digest('hex');
  return hash === signature;
}

function parseXml(xml) {
  const result = {};
  const tags = xml.match(/<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/g) || [];
  tags.forEach(tag => {
    const match = tag.match(/<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/);
    if (match) result[match[1]] = match[2];
  });
  const simpleTags = xml.match(/<(\w+)>([^<]*)<\/\1>/g) || [];
  simpleTags.forEach(tag => {
    const match = tag.match(/<(\w+)>([^<]*)<\/\1>/);
    if (match) result[match[1]] = match[2];
  });
  return result;
}

function buildReplyXml(toUser, fromUser, content) {
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

async function callCozeAPI(userMessage, openId) {
  try {
    const response = await axios.post(
      `${COZE_API_BASE}/v3/chat`,
      {
        bot_id: COZE_BOT_ID,
        user_id: openId,
        stream: false,
        auto_save_history: true,
        additional_messages: [{ role: 'user', content: userMessage, content_type: 'text' }],
      },
      {
        headers: { Authorization: `Bearer ${COZE_PAT}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      }
    );
    const data = response.data;
    if (data.code !== 0) {
      console.error('Coze API error:', data.code, data.msg);
      return `⚠️ 智能体响应异常，请稍后再试。`;
    }
    const chatId = data.data?.id;
    const conversationId = data.data?.conversation_id;
    if (!chatId || !conversationId) return '⚠️ 智能体未返回有效结果，请稍后再试。';
    const msgResponse = await axios.get(
      `${COZE_API_BASE}/v3/chat/message/list`,
      { params: { conversation_id: conversationId, chat_id: chatId }, headers: { Authorization: `Bearer ${COZE_PAT}` }, timeout: 30000 }
    );
    const msgData = msgResponse.data;
    if (msgData.code !== 0 || !msgData.data) return '⚠️ 获取回复失败，请稍后再试。';
    const answers = msgData.data.filter(m => m.type === 'answer' && m.role === 'assistant');
    if (answers.length === 0) return '⚠️ 智能体未生成回复，请稍后再试。';
    return answers.map(a => a.content).join('\n');
  } catch (error) {
    console.error('Coze API call failed:', error.message);
    if (error.code === 'ECONNABORTED') return '⏱️ 智能体响应超时，请稍后再试。';
    return '⚠️ 服务暂时不可用，请稍后再试。';
  }
}

// GET: 微信签名验证
router.get('/', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;
  if (checkSignature(signature, timestamp, nonce)) {
    console.log('微信签名验证通过');
    res.send(echostr);
  } else {
    res.status(403).send('Forbidden');
  }
});

// POST: 接收微信消息
router.post('/', async (req, res) => {
  try {
    const xmlBody = typeof req.body === 'string' ? req.body : (req.rawBody || '');
    console.log('收到微信消息:', xmlBody.substring(0, 500));
    const message = parseXml(xmlBody);
    const msgType = message.MsgType;
    const content = message.Content || '';
    const toUser = message.ToUserName || '';
    const fromUser = message.FromUserName || '';

    if (msgType !== 'text') {
      res.set('Content-Type', 'application/xml');
      return res.send(buildReplyXml(fromUser, toUser, '👋 目前仅支持文字咨询，请输入您的问题。'));
    }
    if (!content.trim()) {
      res.set('Content-Type', 'application/xml');
      return res.send(buildReplyXml(fromUser, toUser, '请输入您的问题～'));
    }

    const reply = await callCozeAPI(content, fromUser);
    res.set('Content-Type', 'application/xml');
    res.send(buildReplyXml(fromUser, toUser, reply));
  } catch (error) {
    console.error('处理消息异常:', error.message);
    res.status(500).send('error');
  }
});

module.exports = router;
