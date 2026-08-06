const OUT_OF_SCOPE_PATTERNS = [
  /\b(?:write|generate|show|give|create)\b[\s\S]{0,80}\b(?:python|javascript|typescript|java|c\+\+|sql|shell|bash)\b[\s\S]{0,40}\b(?:code|script|program|function|query)\b/i,
  /\b(?:recipe|poem|song|lyrics|horoscope|sports score|weather forecast)\b/i,
  /\b(?:ignore|disregard|override)\b[\s\S]{0,60}\b(?:previous|system|developer|instructions|prompt)\b/i,
  /\b(?:reveal|repeat|print|show)\b[\s\S]{0,60}\b(?:system prompt|developer message|hidden instructions|api key|secret)\b/i,
];

export function classifyAssistantRequest(message: string) {
  const matched = OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(message));
  return matched
    ? { inScope: false, reason: "This assistant can only discuss, review, or draft language for the current contract." }
    : { inScope: true, reason: null };
}
