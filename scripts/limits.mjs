// Chrome limits, from the chrome.declarativeNetRequest API constants.
// Shared by check.mjs (enforces them) and refresh-summary.mjs (reports the
// headroom). The Safari figures are SAFARI_LIMITS in safari.mjs.
export const CHROME_LIMITS = {
  GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
  MAX_NUMBER_OF_REGEX_RULES: 1_000,
};
