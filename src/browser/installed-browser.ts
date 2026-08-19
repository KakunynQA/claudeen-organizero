import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "../config/config.js";
import type { ProviderName } from "../types/index.js";

export interface InstalledBrowser {
  name: "Google Chrome" | "Brave Browser" | "Microsoft Edge" | "Chromium";
  executablePath: string;
}

function candidate(name: InstalledBrowser["name"], path: string | undefined): InstalledBrowser | undefined {
  return path && existsSync(path) ? { name, executablePath: path } : undefined;
}

export function findInstalledBrowser(): InstalledBrowser | undefined {
  const candidates: Array<InstalledBrowser | undefined> = process.platform === "win32"
    ? [
        candidate("Google Chrome", process.env.ProgramFiles && resolve(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe")),
        candidate("Google Chrome", process.env["ProgramFiles(x86)"] && resolve(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe")),
        candidate("Google Chrome", process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")),
        candidate("Brave Browser", process.env.ProgramFiles && resolve(process.env.ProgramFiles, "BraveSoftware/Brave-Browser/Application/brave.exe")),
        candidate("Brave Browser", process.env["ProgramFiles(x86)"] && resolve(process.env["ProgramFiles(x86)"], "BraveSoftware/Brave-Browser/Application/brave.exe")),
        candidate("Brave Browser", process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "BraveSoftware/Brave-Browser/Application/brave.exe")),
        candidate("Microsoft Edge", process.env.ProgramFiles && resolve(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe")),
        candidate("Microsoft Edge", process.env["ProgramFiles(x86)"] && resolve(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe")),
        candidate("Microsoft Edge", process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Microsoft/Edge/Application/msedge.exe")),
      ]
    : process.platform === "darwin"
      ? [
          candidate("Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          candidate("Brave Browser", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
          candidate("Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
          candidate("Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ]
      : [
          candidate("Google Chrome", "/usr/bin/google-chrome"),
          candidate("Google Chrome", "/usr/bin/google-chrome-stable"),
          candidate("Brave Browser", "/usr/bin/brave-browser"),
          candidate("Brave Browser", "/usr/bin/brave"),
          candidate("Microsoft Edge", "/usr/bin/microsoft-edge"),
          candidate("Chromium", "/usr/bin/chromium"),
          candidate("Chromium", "/usr/bin/chromium-browser"),
        ];
  return candidates.find((item): item is InstalledBrowser => Boolean(item));
}

export async function runNativeLogin(
  provider: ProviderName,
  config: AppConfig,
): Promise<void> {
  const browser = findInstalledBrowser();
  if (!browser) {
    throw new Error(
      "Google OAuth needs a normally installed Chrome or Edge. Install one, then run the login command again.",
    );
  }

  const profileDir = resolve(config.stateDir, "browser", provider);
  await mkdir(profileDir, { recursive: true });
  console.log(`Browser: ${browser.name}`);
  console.log("This login window is not controlled by Playwright.");
  console.log("Log in manually, wait for the authenticated app to load, then close the entire browser window.\n");

  const child = spawn(browser.executablePath, [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    config.urls[provider],
  ], {
    stdio: "ignore",
    windowsHide: false,
  });

  await new Promise<void>((resolvePromise, reject) => {
    const stopChild = (): void => { child.kill(); };
    process.once("SIGINT", stopChild);
    process.once("SIGTERM", stopChild);
    child.once("error", reject);
    child.once("close", (code) => {
      process.removeListener("SIGINT", stopChild);
      process.removeListener("SIGTERM", stopChild);
      if (code === 0 || code === null) resolvePromise();
      else reject(new Error(`${browser.name} exited with code ${code}`));
    });
  });

  console.log("Browser closed. The dedicated profile was saved; organize will verify the session.");
}
