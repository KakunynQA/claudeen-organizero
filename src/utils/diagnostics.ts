import type { Page } from "playwright";

export async function sanitizedPageHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, noscript").forEach((element) => element.remove());
    clone.querySelectorAll("input, textarea").forEach((element) => {
      element.removeAttribute("value");
      element.textContent = "";
    });
    clone.querySelectorAll("[contenteditable='true']").forEach((element) => { element.textContent = ""; });
    for (const element of clone.querySelectorAll<HTMLElement>("*")) {
      for (const attribute of [...element.attributes]) {
        if (/token|secret|authorization|cookie|credential/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    }
    return `<!doctype html>\n${clone.outerHTML}`;
  }).catch(() => "");
}

export function sanitizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "";
  }
}
