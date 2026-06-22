import * as vscode from 'vscode';

type Language = 'en' | 'zh';

interface StringMap {
  [key: string]: string;
}

export class LanguageManager {
  private static instance: LanguageManager;
  private currentLang: Language;
  private enStrings: StringMap;
  private zhStrings: StringMap;
  private listeners: Set<() => void> = new Set();

  private constructor() {
    this.currentLang = this.getSetting();
    try {
      this.enStrings = require('../locales/en.json');
      this.zhStrings = require('../locales/zh.json');
    } catch {
      this.enStrings = {};
      this.zhStrings = {};
    }
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('harmony.language')) {
        this.currentLang = this.getSetting();
        this.notifyListeners();
      }
    });
  }

  static getInstance(): LanguageManager {
    if (!this.instance) this.instance = new LanguageManager();
    return this.instance;
  }

  private getSetting(): Language {
    const val = vscode.workspace.getConfiguration('harmony').get<string>('language');
    return val === 'zh' ? 'zh' : 'en';
  }

  getString(key: string): string {
    const map = this.currentLang === 'zh' ? this.zhStrings : this.enStrings;
    return map[key] ?? key;
  }

  getCurrentLang(): Language {
    return this.currentLang;
  }

  getLanguageInstruction(): string {
    return this.currentLang === 'zh'
      ? this.getString('lang.instruction')
      : this.getString('lang.instruction');
  }

  onDidChangeLanguage(callback: () => void): vscode.Disposable {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }

  private notifyListeners() {
    this.listeners.forEach(cb => cb());
  }
}
