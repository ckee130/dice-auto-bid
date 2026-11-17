/** Keep extension provider additions reproducible when refreshing the vendor bundle. */
export function patchGeneration(source) {
  const anchor = '  switch (request.provider) {';
  if (!source.includes(anchor)) throw new Error("Vendor provider dispatch changed; update the DeepSeek patch.");
  return 'import { callDeepSeek } from "../deepseek.js";\n' + source
    .replace(anchor, `${anchor}\n    case "deepseek":\n      return callDeepSeek(request, ProviderError);`)
    .replace('var DEFAULT_MODELS = {', 'var DEFAULT_MODELS = {\n  deepseek: "deepseek-flash",')
    .replace('var PROVIDER_LABELS = {', 'var PROVIDER_LABELS = {\n  deepseek: "DeepSeek",');
}
