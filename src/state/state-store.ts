import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProcessedChat, Project, ProjectProfile, ProviderName } from "../types/index.js";

interface ProjectsFile { updatedAt: string; projects: Project[] }
interface ChatsFile { updatedAt: string; chats: ProcessedChat[] }
export interface ProjectIndexFile { projects: Record<string, ProjectProfile> }

export class StateStore {
  constructor(private readonly stateDir: string, private readonly provider: ProviderName) {}

  private dataPath(file: string): string {
    return resolve(this.stateDir, "data", this.provider, file);
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    try { return JSON.parse(await readFile(path, "utf8")) as T; }
    catch (error) { throw new Error(`Cannot read state file ${path}: ${String(error)}`); }
  }

  private async atomicJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  async loadProjects(): Promise<ProjectsFile> {
    return this.readJson(this.dataPath("projects.json"), { updatedAt: "", projects: [] });
  }

  async saveProjects(projects: Project[]): Promise<void> {
    await this.atomicJson(this.dataPath("projects.json"), { updatedAt: new Date().toISOString(), projects });
  }

  async loadChats(): Promise<ChatsFile> {
    return this.readJson(this.dataPath("chats.json"), { updatedAt: "", chats: [] });
  }

  async upsertChat(chat: ProcessedChat): Promise<void> {
    const file = await this.loadChats();
    const index = file.chats.findIndex((item) => item.key === chat.key);
    if (index >= 0) file.chats[index] = chat;
    else file.chats.push(chat);
    await this.atomicJson(this.dataPath("chats.json"), { updatedAt: new Date().toISOString(), chats: file.chats });
  }

  async loadProjectIndex(): Promise<ProjectIndexFile> {
    return this.readJson(this.dataPath("project-index.json"), { projects: {} });
  }

  async saveProjectIndex(index: ProjectIndexFile): Promise<void> {
    await this.atomicJson(this.dataPath("project-index.json"), index);
  }

  async recordAction(action: Record<string, unknown>): Promise<void> {
    const path = this.dataPath("actions.ndjson");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...action })}\n`, { mode: 0o600 });
  }

  async summary(): Promise<{ projects: number; chats: number; byStatus: Record<string, number> }> {
    const [projects, chats] = await Promise.all([this.loadProjects(), this.loadChats()]);
    const byStatus: Record<string, number> = {};
    for (const chat of chats.chats) byStatus[chat.status] = (byStatus[chat.status] ?? 0) + 1;
    return { projects: projects.projects.length, chats: chats.chats.length, byStatus };
  }
}

export function chatKey(provider: ProviderName, chat: { id?: string; url?: string; title: string }): string {
  const stable = chat.id || chat.url || chat.title.trim();
  return `${provider}:${stable.toLocaleLowerCase()}`;
}
