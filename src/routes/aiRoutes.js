const express = require('express');
const router = express.Router();
const { getApiKey, saveApiKeyToEnv, generateAIAnswer } = require('../services/aiService');

// Get AI Key configuration status
router.get('/status', (req, res) => {
  const key = getApiKey();
  const hasKey = Boolean(key && key.trim().length > 5);
  let provider = 'none';
  let maskedKey = '';

  if (hasKey) {
    provider = (key.startsWith('AIzaSy') || !key.startsWith('sk-')) ? 'Google Gemini' : 'OpenAI';
    maskedKey = key.length > 8 ? `${key.substring(0, 6)}...${key.substring(key.length - 4)}` : '****';
  }

  res.json({
    success: true,
    hasKey,
    provider,
    maskedKey
  });
});

// Save or update API Key
router.post('/save-key', (req, res) => {
  const { apiKey, provider } = req.body;

  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Invalid API key format. Please enter a valid Gemini or OpenAI API key.'
    });
  }

  const trimmedKey = apiKey.trim();
  const result = saveApiKeyToEnv(trimmedKey, provider);

  res.json({
    success: true,
    message: 'API key linked and saved successfully! SplitVerse AI is now running live LLM intelligence.',
    provider: result.provider
  });
});

// Generate AI Response for Accountant or Multi-Agent Hub
router.post('/chat', async (req, res) => {
  try {
    const { query, history, userContext, agentType, customApiKey } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ success: false, message: 'Query string is required.' });
    }

    const aiResult = await generateAIAnswer({
      query: query.trim(),
      userContext: userContext || {},
      history: history || [],
      customApiKey: customApiKey || '',
      agentType: agentType || 'accountant'
    });

    res.json({
      success: true,
      ...aiResult
    });
  } catch (err) {
    console.error('Error in /api/ai/chat:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'AI request failed'
    });
  }
});

module.exports = router;
