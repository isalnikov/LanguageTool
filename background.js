/**
 * @fileoverview Background Service Worker для Chrome Extension
 * Управляет загрузкой словарей, обработкой запросов и контекстным меню
 */

'use strict';

// ============================================
// Logger (встроенный, чтобы не зависеть от window)
// ============================================

const Logger = (function() {
  const LEVELS = { DEBUG: 0, LOG: 1, INFO: 2, WARN: 3, ERROR: 4 };
  
  class Logger {
    constructor(context = 'app') {
      this.context = context;
      this.enabled = true;
      this.logLevel = LEVELS.INFO;
      this.maxStoredLogs = 1000;
    }

    formatMessage(level, args) {
      return {
        timestamp: new Date().toISOString(),
        context: this.context,
        level,
        message: args.map(arg => 
          typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' '),
        args: args
      };
    }

    logToConsole(level, args) {
      const prefix = `[${this.context}]`;
      const consoleMethod = level.toLowerCase();
      if (console[consoleMethod]) {
        console[consoleMethod](prefix, ...args);
      } else {
        console.log(prefix, ...args);
      }
    }

    async saveToStorage(logEntry) {
      try {
        const storage = await chrome.storage.local.get(['logs']);
        const logs = storage.logs || [];
        logs.push(logEntry);
        if (logs.length > this.maxStoredLogs) logs.shift();
        await chrome.storage.local.set({ logs });
      } catch (error) {
        console.error('[Logger] Ошибка сохранения лога:', error);
      }
    }

    async logMessage(level, ...args) {
      if (!this.enabled) return;
      const levelNum = LEVELS[level];
      if (levelNum < this.logLevel) return;
      const logEntry = this.formatMessage(level, args);
      this.logToConsole(level, args);
      this.saveToStorage(logEntry);
    }

    debug(...args) { this.logMessage('DEBUG', ...args); }
    log(...args) { this.logMessage('LOG', ...args); }
    info(...args) { this.logMessage('INFO', ...args); }
    warn(...args) { this.logMessage('WARN', ...args); }
    error(...args) { this.logMessage('ERROR', ...args); }
  }
  
  return Logger;
})();

const logger = new Logger('background');

// ============================================
// Trie (встроенный, чтобы не зависеть от window)
// ============================================

const Trie = (function() {
  class TrieNode {
    constructor() {
      this.children = new Map();
      this.isEndOfWord = false;
    }
  }

  class Trie {
    constructor() {
      this.root = new TrieNode();
      this.wordCount = 0;
    }

    insert(word) {
      if (!word || word.trim() === '') return;
      const normalizedWord = word.toLowerCase().trim();
      let node = this.root;
      for (const char of normalizedWord) {
        if (!node.children.has(char)) {
          node.children.set(char, new TrieNode());
        }
        node = node.children.get(char);
      }
      if (!node.isEndOfWord) {
        node.isEndOfWord = true;
        this.wordCount++;
      }
    }

    insertBatch(words) {
      for (const word of words) this.insert(word);
    }

    has(word) {
      if (!word || word.trim() === '') return false;
      const normalizedWord = word.toLowerCase().trim();
      let node = this.root;
      for (const char of normalizedWord) {
        if (!node.children.has(char)) return false;
        node = node.children.get(char);
      }
      return node.isEndOfWord;
    }

    findByPrefix(prefix, limit = 10) {
      if (!prefix || prefix.trim() === '') return [];
      const normalizedPrefix = prefix.toLowerCase().trim();
      let node = this.root;
      for (const char of normalizedPrefix) {
        if (!node.children.has(char)) return [];
        node = node.children.get(char);
      }
      const results = [];
      this._collectWords(node, normalizedPrefix, results, limit);
      return results;
    }

    _collectWords(node, prefix, results, limit) {
      if (results.length >= limit) return;
      if (node.isEndOfWord) results.push(prefix);
      for (const [char, childNode] of node.children) {
        if (results.length >= limit) break;
        this._collectWords(childNode, prefix + char, results, limit);
      }
    }

    size() { return this.wordCount; }
    clear() {
      this.root = new TrieNode();
      this.wordCount = 0;
    }
  }
  
  return Trie;
})();

// ============================================
// DictionaryManager (встроенный)
// ============================================

const DictionaryManager = (function() {
  class DictionaryManager {
    constructor() {
      this.dictionaries = new Map();
      this.loadedLanguages = new Set();
    }

    loadDictionary(lang, words) {
      console.log(`[DictionaryManager] Загрузка словаря ${lang}: ${words.length} слов`);
      const trie = new Trie();
      trie.insertBatch(words);
      this.dictionaries.set(lang, trie);
      this.loadedLanguages.add(lang);
      console.log(`[DictionaryManager] Словарь ${lang} загружен. Размер: ${trie.size()} слов`);
    }

    checkWord(lang, word) {
      const trie = this.dictionaries.get(lang);
      if (!trie) {
        console.warn(`[DictionaryManager] Словарь ${lang} не загружен`);
        return false;
      }
      return trie.has(word);
    }

    getSuggestions(lang, prefix, limit = 10) {
      const trie = this.dictionaries.get(lang);
      if (!trie) return [];
      return trie.findByPrefix(prefix, limit);
    }

    isDictionaryLoaded(lang) {
      return this.loadedLanguages.has(lang);
    }

    getDictionarySize(lang) {
      const trie = this.dictionaries.get(lang);
      return trie ? trie.size() : 0;
    }

    detectLanguage(word) {
      const cyrillicRegex = /[\u0400-\u04FF]/;
      if (cyrillicRegex.test(word)) return 'ru';
      const latinRegex = /[a-zA-Z]/;
      if (latinRegex.test(word)) return 'en';
      return null;
    }

    checkWordAuto(word) {
      const lang = this.detectLanguage(word);
      if (!lang) return { isValid: true, lang: null };
      const isValid = this.checkWord(lang, word);
      return { isValid, lang };
    }

    getSuggestionsAuto(prefix, limit = 10) {
      const lang = this.detectLanguage(prefix);
      if (!lang) return [];
      return this.getSuggestions(lang, prefix, limit);
    }
  }
  
  return DictionaryManager;
})();

// ============================================
// DictionaryDB (встроенный для background)
// ============================================

const DictionaryDB = (function() {
  const DB_NAME = 'LanguageToolDictDB';
  const DB_VERSION = 1;
  const STORE_NAMES = {
    EN: 'english_words',
    RU: 'russian_words',
    META: 'metadata'
  };

  class DictionaryDB {
    constructor() {
      this.db = null;
      this.isOpen = false;
    }

    async open() {
      if (this.isOpen && this.db) return this.db;

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
          console.error('[DictionaryDB] Ошибка открытия базы данных:', request.error);
          reject(request.error);
        };

        request.onsuccess = () => {
          this.db = request.result;
          this.isOpen = true;
          console.log('[DictionaryDB] База данных успешно открыта');
          resolve(this.db);
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          console.log('[DictionaryDB] Создание хранилищ данных...');

          if (!db.objectStoreNames.contains(STORE_NAMES.EN)) {
            const enStore = db.createObjectStore(STORE_NAMES.EN, { keyPath: 'id', autoIncrement: true });
            enStore.createIndex('word', 'word', { unique: true });
          }

          if (!db.objectStoreNames.contains(STORE_NAMES.RU)) {
            const ruStore = db.createObjectStore(STORE_NAMES.RU, { keyPath: 'id', autoIncrement: true });
            ruStore.createIndex('word', 'word', { unique: true });
          }

          if (!db.objectStoreNames.contains(STORE_NAMES.META)) {
            db.createObjectStore(STORE_NAMES.META, { keyPath: 'key' });
          }
        };
      });
    }

    async bulkInsert(storeName, words, batchSize = 10000) {
      if (!this.db) await this.open();

      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      await new Promise((resolve) => {
        store.clear().onsuccess = resolve;
      });

      console.log(`[DictionaryDB] Вставка ${words.length} слов в ${storeName}...`);

      for (let i = 0; i < words.length; i += batchSize) {
        const batch = words.slice(i, i + batchSize);
        const batchPromises = batch.map(word => {
          return new Promise((resolve, reject) => {
            const request = store.add({ word: word.toLowerCase() });
            request.onsuccess = resolve;
            request.onerror = reject;
          });
        });

        await Promise.all(batchPromises);
        console.log(`[DictionaryDB] Обработано ${Math.min(i + batchSize, words.length)} из ${words.length} слов`);
      }

      return new Promise((resolve) => {
        transaction.oncomplete = () => {
          console.log(`[DictionaryDB] Вставка завершена: ${words.length} слов`);
          resolve();
        };
      });
    }

    async getCount(storeName) {
      if (!this.db) await this.open();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.count();

        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
    }

    async loadAllWords(storeName) {
      if (!this.db) await this.open();

      return new Promise((resolve, reject) => {
        const words = [];
        const transaction = this.db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.openCursor();

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            words.push(cursor.value.word);
            cursor.continue();
          } else {
            resolve(words);
          }
        };
        request.onerror = reject;
      });
    }
  }

  return new DictionaryDB();
})();

// ============================================
// Глобальные переменные
// ============================================

const dictManager = new DictionaryManager();
const wordCache = new Map();

// ============================================
// Функции инициализации
// ============================================

async function init() {
  logger.log('Инициализация LanguageTool Offline...');
  
  try {
    await DictionaryDB.open();
    logger.log('IndexedDB открыта');
    
    const enCount = await DictionaryDB.getCount('english_words');
    const ruCount = await DictionaryDB.getCount('russian_words');
    
    logger.log(`Словари в IndexedDB: en=${enCount}, ru=${ruCount}`);
    
    if (enCount === 0 || ruCount === 0) {
      logger.log('Словари пусты, начинаем загрузку...');
      await loadDictionariesFromFiles();
    } else {
      await loadDictionariesIntoTrie();
    }
    
    logger.log('Инициализация завершена');
  } catch (error) {
    logger.error('Ошибка инициализации:', error);
  }
}

async function loadDictionariesFromFiles() {
  try {
    logger.log('Загрузка английского словаря...');
    const enResponse = await fetch(chrome.runtime.getURL('vocab/en/words.txt'));
    const enText = await enResponse.text();
    const enWords = enText.split('\n').filter(w => w.trim());
    
    await DictionaryDB.bulkInsert('english_words', enWords);
    logger.log(`Английский словарь загружен: ${enWords.length} слов`);
    
    logger.log('Загрузка русского словаря...');
    const ruResponse = await fetch(chrome.runtime.getURL('vocab/ru/words.txt'));
    const ruText = await ruResponse.text();
    const ruWords = ruText.split('\n').filter(w => w.trim());
    
    await DictionaryDB.bulkInsert('russian_words', ruWords);
    logger.log(`Русский словарь загружен: ${ruWords.length} слов`);
    
    await loadDictionariesIntoTrie();
    
  } catch (error) {
    logger.error('Ошибка загрузки словарей:', error);
  }
}

async function loadDictionariesIntoTrie() {
  try {
    logger.log('Загрузка словарей в память (Trie)...');
    
    const enWords = await DictionaryDB.loadAllWords('english_words');
    dictManager.loadDictionary('en', enWords);
    
    const ruWords = await DictionaryDB.loadAllWords('russian_words');
    dictManager.loadDictionary('ru', ruWords);
    
    logger.log(`Словари загружены в память: en=${enWords.length}, ru=${ruWords.length}`);
    
    await chrome.storage.local.set({
      dictionariesLoaded: true,
      enWordCount: enWords.length,
      ruWordCount: ruWords.length,
      lastLoadTime: Date.now()
    });
    
  } catch (error) {
    logger.error('Ошибка загрузки в Trie:', error);
  }
}

// ============================================
// Обработчики сообщений
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.log('Получено сообщение:', message.type);
  
  switch (message.type) {
    case 'CHECK_WORD':
      handleCheckWord(message.word)
        .then(sendResponse)
        .catch(err => {
          logger.error('Ошибка проверки слова:', err);
          sendResponse({ isValid: false, error: err.message });
        });
      return true;
    
    case 'GET_SUGGESTIONS':
      handleGetSuggestions(message.word)
        .then(sendResponse)
        .catch(err => {
          logger.error('Ошибка получения подсказок:', err);
          sendResponse([]);
        });
      return true;
    
    case 'GET_STATUS':
      handleGetStatus()
        .then(sendResponse)
        .catch(err => {
          logger.error('Ошибка получения статуса:', err);
          sendResponse({ loaded: false, error: err.message });
        });
      return true;
    
    case 'RELOAD_DICTIONARIES':
      handleReloadDictionaries()
        .then(sendResponse)
        .catch(err => {
          logger.error('Ошибка перезагрузки словарей:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    
    default:
      logger.warn('Неизвестный тип сообщения:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

async function handleCheckWord(word) {
  if (!word || word.trim() === '') {
    return { isValid: true, lang: null };
  }
  
  const result = dictManager.checkWordAuto(word.trim());
  logger.log(`Проверка слова "${word}": ${result.isValid ? 'верно' : 'ошибка'} (${result.lang})`);
  
  return result;
}

async function handleGetSuggestions(word) {
  if (!word || word.trim() === '') {
    return [];
  }
  
  const suggestions = dictManager.getSuggestionsAuto(word.trim(), 10);
  logger.log(`Подсказки для "${word}": ${suggestions.length} найдено`);
  
  return suggestions;
}

async function handleGetStatus() {
  const enCount = dictManager.getDictionarySize('en');
  const ruCount = dictManager.getDictionarySize('ru');
  
  return {
    loaded: dictManager.loadedLanguages.size > 0,
    enCount,
    ruCount,
    total: enCount + ruCount
  };
}

async function handleReloadDictionaries() {
  try {
    dictManager.dictionaries.clear();
    dictManager.loadedLanguages.clear();
    wordCache.clear();
    
    await loadDictionariesIntoTrie();
    
    return { success: true };
  } catch (error) {
    logger.error('Ошибка перезагрузки:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// Контекстное меню
// ============================================

function createContextMenu() {
  chrome.contextMenus.create({
    id: 'languagetool-replace',
    title: 'Заменить на "%s"',
    contexts: ['selection']
  });
  
  chrome.contextMenus.create({
    id: 'languagetool-suggestions',
    title: 'Предложения для "%s"',
    contexts: ['selection']
  });
  
  chrome.contextMenus.create({
    id: 'languagetool-ignore',
    title: 'Пропустить слово',
    contexts: ['selection']
  });
  
  logger.log('Контекстное меню создано');
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  logger.log('Клик по контекстному меню:', info.menuItemId);
  
  if (info.menuItemId === 'languagetool-ignore') {
    addWordToIgnore(info.selectionText);
  } else if (info.menuItemId.startsWith('languagetool-replace-')) {
    const replacement = info.menuItemId.replace('languagetool-replace-', '');
    replaceWordInTab(tab.id, info.selectionText, replacement);
  }
});

async function addWordToIgnore(word) {
  const storage = await chrome.storage.local.get(['ignoredWords']);
  const ignoredWords = storage.ignoredWords || [];
  
  if (!ignoredWords.includes(word.toLowerCase())) {
    ignoredWords.push(word.toLowerCase());
    await chrome.storage.local.set({ ignoredWords });
    logger.log(`Слово "${word}" добавлено в исключения`);
  }
}

function replaceWordInTab(tabId, oldWord, newWord) {
  chrome.tabs.sendMessage(tabId, {
    type: 'REPLACE_WORD',
    oldWord,
    newWord
  });
  
  logger.log(`Замена "${oldWord}" -> "${newWord}" во вкладке ${tabId}`);
}

// ============================================
// Запуск
// ============================================

createContextMenu();
init();

chrome.runtime.onInstalled.addListener(() => {
  logger.log('Расширение установлено/обновлено');
  init();
});
