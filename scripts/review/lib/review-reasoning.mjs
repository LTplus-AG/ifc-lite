/* SPDX-License-Identifier: MPL-2.0 */
// OpenRouter model metadata checked 2026-10-02. DeepSeek v4 Flash accepts only
// high/xhigh effort, but reasoning is optional: disable it rather than sending
// an unsupported low effort. Strong seats retain high reasoning in both profiles.
export function reviewReasoning(model, profile = 'high') {
  if (!['high', 'cheap-defaults'].includes(profile)) throw new Error(`Unknown review reasoning profile: ${profile}`);
  if (profile === 'cheap-defaults') {
    if (model === 'openai/gpt-6-luna') return { effort: 'medium' };
    if (model === 'google/gemini-3.5-flash-lite') return { effort: 'minimal' };
    if (model === 'deepseek/deepseek-v4-flash') return { enabled: false };
  }
  return { effort: 'high' };
}
