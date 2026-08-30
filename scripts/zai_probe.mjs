/** Quick SDK connectivity probe. */
const ZAI = (await import('z-ai-web-dev-sdk')).default
const zai = await ZAI.create()
const t0 = Date.now()
const res = await zai.chat.completions.create({
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  model: 'glm-4.5-flash',
  maxTokens: 8,
})
console.log('reply:', JSON.stringify(res.choices[0]?.message?.content), 'in', Date.now() - t0, 'ms')
