/** Default profiles and shared settings; credentials belong only in the login manager. */

// Keep the existing DeepSeek preference names and defaults.
pref("extensions.paperbridge.profile", "deepseek");
pref("extensions.paperbridge.model", "deepseek-flash");
pref("extensions.paperbridge.baseURL", "https://api.deepseek.com");
// The optional compatible profile requires its own endpoint, model, and key.
pref("extensions.paperbridge.compatibleModel", "");
pref("extensions.paperbridge.compatibleBaseURL", "");
pref("extensions.paperbridge.compatibleJSON", true);
pref("extensions.paperbridge.compatibleMaxTokens", 8192);
// Language, page selection, and the local interpreter are shared by both profiles.
pref("extensions.paperbridge.language", "zh-CN");
pref("extensions.paperbridge.pages", "");
pref("extensions.paperbridge.pythonPath", "");
