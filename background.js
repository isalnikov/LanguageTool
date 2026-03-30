/**
 * @fileoverview Background Service Worker для Chrome Extension
 * Управляет загрузкой словарей, обработкой запросов и контекстным меню
 * 
 * ЛОГИРОВАНИЕ:
 * - Все этапы инициализации логируются
 * - Ошибки детально протоколируются
 * - Статус загрузки доступен через GET_STATUS
 */

'use strict';

// ============================================
// Logger (встроенный)
// ============================================

const Logger = (function() {
  const LEVELS = { DEBUG: 0, LOG: 1, INFO: 2, WARN: 3, ERROR: 4 };
  
  class Logger {
    constructor(context = 'app') {
      this.context = context;
      this.enabled = true;
      this.logLevel = LEVELS.DEBUG; // Максимальный уровень для отладки
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
    
    async getLogs() {
      const storage = await chrome.storage.local.get(['logs']);
      return storage.logs || [];
    }
    
    async clearLogs() {
      await chrome.storage.local.set({ logs: [] });
      this.info('Логи очищены');
    }
  }
  
  return Logger;
})();

const logger = new Logger('background');

// ============================================
// Trie (встроенный)
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
      this.lastError = null;
    }

    async open() {
      logger.log('DictionaryDB.open() вызван');
      
      if (this.isOpen && this.db) {
        logger.log('База данных уже открыта');
        return this.db;
      }

      return new Promise((resolve, reject) => {
        logger.log(`Открытие IndexedDB: ${DB_NAME}, версия ${DB_VERSION}`);
        
        try {
          const request = indexedDB.open(DB_NAME, DB_VERSION);

          request.onerror = (event) => {
            const error = request.error || event.target.error;
            this.lastError = error;
            logger.error('IndexedDB onerror:', error);
            reject(error);
          };

          request.onblocked = (event) => {
            logger.warn('IndexedDB заблокирована:', event);
          };

          request.onsuccess = () => {
            this.db = request.result;
            this.isOpen = true;
            this.lastError = null;
            logger.log('База данных успешно открыта:', this.db.name);
            resolve(this.db);
          };

          request.onupgradeneeded = (event) => {
            logger.log('onupgradeneeded:', event.oldVersion, '->', event.newVersion);
            const db = event.target.result;

            try {
              if (!db.objectStoreNames.contains(STORE_NAMES.EN)) {
                logger.log('Создание хранилища:', STORE_NAMES.EN);
                const enStore = db.createObjectStore(STORE_NAMES.EN, { keyPath: 'id', autoIncrement: true });
                enStore.createIndex('word', 'word', { unique: true });
              }

              if (!db.objectStoreNames.contains(STORE_NAMES.RU)) {
                logger.log('Создание хранилища:', STORE_NAMES.RU);
                const ruStore = db.createObjectStore(STORE_NAMES.RU, { keyPath: 'id', autoIncrement: true });
                ruStore.createIndex('word', 'word', { unique: true });
              }

              if (!db.objectStoreNames.contains(STORE_NAMES.META)) {
                logger.log('Создание хранилища:', STORE_NAMES.META);
                db.createObjectStore(STORE_NAMES.META, { keyPath: 'key' });
              }
              
              logger.log('Хранилища созданы успешно');
            } catch (storeError) {
              logger.error('Ошибка создания хранилищ:', storeError);
              reject(storeError);
            }
          };
        } catch (error) {
          logger.error('Исключение при открытии IndexedDB:', error);
          reject(error);
        }
      });
    }

    async bulkInsert(storeName, words, batchSize = 5000) {
      logger.log(`=== bulkInsert: ${storeName}, ${words.length} слов, batchSize=${batchSize} ===`);
      
      if (!this.db) {
        logger.log('База данных не открыта, открываем...');
        await this.open();
      }

      try {
        // Очищаем хранилище перед вставкой
        logger.log('Очистка хранилища...');
        const clearTx = this.db.transaction([storeName], 'readwrite');
        const clearStore = clearTx.objectStore(storeName);
        
        await new Promise((resolve, reject) => {
          clearTx.oncomplete = () => {
            logger.log('✓ Хранилище очищено');
            resolve();
          };
          clearTx.onerror = (e) => {
            logger.error('Ошибка очистки:', e);
            reject(e);
          };
          clearTx.onabort = (e) => {
            logger.error('Очистка прервана:', e);
            reject(e);
          };
          clearStore.clear();
        });

        // Вставляем слова батчами с отдельной транзакцией для каждого
        logger.log(`Вставка ${words.length} слов батчами по ${batchSize}...`);
        let totalInserted = 0;

        for (let i = 0; i < words.length; i += batchSize) {
          const batch = words.slice(i, i + batchSize);
          const batchNum = Math.floor(i / batchSize) + 1;
          const totalBatches = Math.ceil(words.length / batchSize);
          
          logger.log(`Батч ${batchNum}/${totalBatches}: ${batch.length} слов`);
          
          // Создаём новую транзакцию для каждого батча
          const tx = this.db.transaction([storeName], 'readwrite', {
            durability: 'relaxed'
          });
          const store = tx.objectStore(storeName);
          
          let batchSuccess = 0;
          let batchError = 0;
          
          await new Promise((resolve, reject) => {
            tx.oncomplete = () => {
              totalInserted += batchSuccess;
              logger.log(`✓ Батч ${batchNum} завершен: ${batchSuccess} добавлено, ${batchError} ошибок`);
              resolve();
            };
            
            tx.onerror = (e) => {
              logger.error(`Ошибка транзакции батча ${batchNum}:`, e);
              logger.error('Error details:', tx.error);
              reject(tx.error || e);
            };
            
            tx.onabort = (e) => {
              logger.error(`Транзакция батча ${batchNum} прервана:`, e);
              reject(e);
            };
            
            // Добавляем слова
            for (let j = 0; j < batch.length; j++) {
              try {
                const word = batch[j].toLowerCase().trim();
                if (!word) continue;
                
                const request = store.add({ word });
                
                request.onsuccess = () => {
                  batchSuccess++;
                };
                
                request.onerror = (e) => {
                  batchError++;
                  // Не прерываем весь батч из-за одной ошибки
                  if (batchError % 100 === 0) {
                    logger.warn(`Батч ${batchNum}: ${batchError} ошибок добавления`);
                  }
                };
              } catch (e) {
                batchError++;
                logger.error(`Исключение при добавлении слова "${batch[j]}":`, e);
              }
            }
          });
          
          // Небольшая пауза между батчами для стабильности
          if (i + batchSize < words.length) {
            await new Promise(r => setTimeout(r, 10));
          }
        }

        logger.log(`=== bulkInsert завершен: ${totalInserted} слов вставлено ===`);
        
      } catch (error) {
        logger.error('=== ОШИБКА bulkInsert ===');
        logger.error('Ошибка:', error);
        logger.error('Type:', typeof error);
        logger.error('Message:', error.message);
        logger.error('Stack:', error.stack);
        throw error;
      }
    }

    async getCount(storeName) {
      logger.log(`getCount: ${storeName}`);
      
      if (!this.db) {
        logger.log('База данных не открыта, открываем...');
        await this.open();
      }

      return new Promise((resolve, reject) => {
        try {
          const transaction = this.db.transaction([storeName], 'readonly');
          const store = transaction.objectStore(storeName);
          const request = store.count();

          request.onsuccess = () => {
            logger.log(`getCount(${storeName}) = ${request.result}`);
            resolve(request.result);
          };
          request.onerror = (e) => {
            logger.error(`getCount error:`, e);
            reject(e);
          };
        } catch (error) {
          logger.error('getCount exception:', error);
          reject(error);
        }
      });
    }

    async loadAllWords(storeName) {
      logger.log(`loadAllWords: ${storeName}`);
      
      if (!this.db) {
        logger.log('База данных не открыта, открываем...');
        await this.open();
      }

      return new Promise((resolve, reject) => {
        try {
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
              logger.log(`loadAllWords(${storeName}): загружено ${words.length} слов`);
              resolve(words);
            }
          };
          request.onerror = (e) => {
            logger.error('loadAllWords error:', e);
            reject(e);
          };
        } catch (error) {
          logger.error('loadAllWords exception:', error);
          reject(error);
        }
      });
    }
    
    async close() {
      logger.log('DictionaryDB.close() вызван');
      if (this.db) {
        this.db.close();
        this.db = null;
        this.isOpen = false;
        logger.log('База данных закрыта');
      }
    }
  }

  return new DictionaryDB();
})();

// ============================================
// Глобальные переменные
// ============================================

const dictManager = new DictionaryManager();
const wordCache = new Map();
let initializationComplete = false;
let initializationError = null;

// ============================================
// Функции инициализации
// ============================================

async function init() {
  logger.log('=== НАЧАЛО ИНИЦИАЛИЗАЦИИ ===');
  logger.log('User Agent:', navigator.userAgent);
  
  try {
    // Шаг 1: Открываем IndexedDB
    logger.log('Шаг 1: Открытие IndexedDB...');
    await DictionaryDB.open();
    logger.log('✓ IndexedDB открыта');
    
    // Шаг 2: Проверяем количество слов
    logger.log('Шаг 2: Проверка количества слов...');
    const enCount = await DictionaryDB.getCount('english_words');
    const ruCount = await DictionaryDB.getCount('russian_words');
    
    logger.log(`Словари в IndexedDB: en=${enCount}, ru=${ruCount}`);
    
    // Шаг 3: Загружаем словари если пусты
    if (enCount === 0 || ruCount === 0) {
      logger.log('Шаг 3: Словари пусты, загрузка из файлов...');
      await loadDictionariesFromFiles();
    } else {
      logger.log('Шаг 3: Загрузка словарей в Trie...');
      await loadDictionariesIntoTrie();
    }
    
    // Шаг 4: Завершение
    initializationComplete = true;
    logger.log('=== ИНИЦИАЛИЗАЦИЯ ЗАВЕРШЕНА УСПЕШНО ===');
  } catch (error) {
    initializationError = error;
    logger.error('=== ИНИЦИАЛИЗАЦИЯ ПРЕРВАНА С ОШИБКОЙ ===');
    logger.error('Ошибка:', error);
    logger.error('Stack:', error.stack);
  }
}

async function loadDictionariesFromFiles() {
  logger.log('=== ЗАГРУЗКА СЛОВАРЕЙ ИЗ ФАЙЛОВ ===');
  
  try {
    // Английский словарь
    logger.log('Загрузка английского словаря...');
    const enUrl = chrome.runtime.getURL('vocab/en/words.txt');
    logger.log('URL английского словаря:', enUrl);
    
    const enResponse = await fetch(enUrl);
    logger.log('Статус ответа EN:', enResponse.status);
    
    if (!enResponse.ok) {
      throw new Error(`HTTP ${enResponse.status}: ${enResponse.statusText}`);
    }
    
    const enText = await enResponse.text();
    logger.log('Размер EN текста:', enText.length, 'символов');
    
    const enWords = enText.split('\n').filter(w => w.trim());
    logger.log('Количество EN слов:', enWords.length);
    
    if (enWords.length === 0) {
      throw new Error('Английский словарь пуст');
    }
    
    await DictionaryDB.bulkInsert('english_words', enWords);
    logger.log('✓ Английский словарь загружен');
    
    // Русский словарь
    logger.log('Загрузка русского словаря...');
    const ruUrl = chrome.runtime.getURL('vocab/ru/words.txt');
    logger.log('URL русского словаря:', ruUrl);
    
    const ruResponse = await fetch(ruUrl);
    logger.log('Статус ответа RU:', ruResponse.status);
    
    if (!ruResponse.ok) {
      throw new Error(`HTTP ${ruResponse.status}: ${ruResponse.statusText}`);
    }
    
    const ruText = await ruResponse.text();
    logger.log('Размер RU текста:', ruText.length, 'символов');
    
    const ruWords = ruText.split('\n').filter(w => w.trim());
    logger.log('Количество RU слов:', ruWords.length);
    
    if (ruWords.length === 0) {
      throw new Error('Русский словарь пуст');
    }
    
    await DictionaryDB.bulkInsert('russian_words', ruWords);
    logger.log('✓ Русский словарь загружен');
    
    // Загружаем в Trie
    logger.log('Загрузка словарей в Trie...');
    await loadDictionariesIntoTrie();
    
    logger.log('=== ЗАГРУЗКА СЛОВАРЕЙ ЗАВЕРШЕНА ===');
    
  } catch (error) {
    logger.error('Ошибка загрузки словарей:', error);
    logger.error('Stack:', error.stack);
    throw error;
  }
}

async function loadDictionariesIntoTrie() {
  logger.log('=== ЗАГРУЗКА СЛОВАРЕЙ В TRIE ===');
  
  try {
    logger.log('Загрузка английского словаря из DB...');
    const enWords = await DictionaryDB.loadAllWords('english_words');
    logger.log(`EN слов загружено: ${enWords.length}`);
    
    if (enWords.length > 0) {
      dictManager.loadDictionary('en', enWords);
      logger.log('✓ Английский словарь в Trie');
    }
    
    logger.log('Загрузка русского словаря из DB...');
    const ruWords = await DictionaryDB.loadAllWords('russian_words');
    logger.log(`RU слов загружено: ${ruWords.length}`);
    
    if (ruWords.length > 0) {
      dictManager.loadDictionary('ru', ruWords);
      logger.log('✓ Русский словарь в Trie');
    }
    
    const enSize = dictManager.getDictionarySize('en');
    const ruSize = dictManager.getDictionarySize('ru');
    
    logger.log(`Словари загружены в память: en=${enSize}, ru=${ruSize}`);
    
    await chrome.storage.local.set({
      dictionariesLoaded: true,
      enWordCount: enSize,
      ruWordCount: ruSize,
      lastLoadTime: Date.now()
    });
    
    logger.log('=== ЗАГРУЗКА В TRIE ЗАВЕРШЕНА ===');
    
  } catch (error) {
    logger.error('Ошибка загрузки в Trie:', error);
    logger.error('Stack:', error.stack);
    throw error;
  }
}

// ============================================
// Обработчики сообщений
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.log('← Сообщение:', message.type, 'от:', sender.tab ? 'tab' : 'popup');
  
  switch (message.type) {
    case 'CHECK_WORD':
      handleCheckWord(message.word)
        .then(result => {
          logger.log('→ CHECK_WORD ответ:', result);
          sendResponse(result);
        })
        .catch(err => {
          logger.error('Ошибка CHECK_WORD:', err);
          sendResponse({ isValid: false, error: err.message });
        });
      return true;
    
    case 'GET_SUGGESTIONS':
      handleGetSuggestions(message.word)
        .then(result => {
          logger.log('→ GET_SUGGESTIONS ответ:', result.length, 'предложений');
          sendResponse(result);
        })
        .catch(err => {
          logger.error('Ошибка GET_SUGGESTIONS:', err);
          sendResponse([]);
        });
      return true;
    
    case 'GET_STATUS':
      handleGetStatus()
        .then(result => {
          logger.log('→ GET_STATUS ответ:', result);
          sendResponse(result);
        })
        .catch(err => {
          logger.error('Ошибка GET_STATUS:', err);
          sendResponse({ loaded: false, error: err.message });
        });
      return true;
    
    case 'RELOAD_DICTIONARIES':
      handleReloadDictionaries()
        .then(result => {
          logger.log('→ RELOAD_DICTIONARIES ответ:', result);
          sendResponse(result);
        })
        .catch(err => {
          logger.error('Ошибка RELOAD_DICTIONARIES:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    
    case 'GET_LOGS':
      logger.getLogs().then(logs => {
        logger.log('→ GET_LOGS ответ:', logs.length, 'записей');
        sendResponse(logs);
      });
      return true;
    
    case 'CLEAR_LOGS':
      logger.clearLogs().then(() => {
        logger.log('→ CLEAR_LOGS: логи очищены');
        sendResponse({ success: true });
      });
      return true;
    
    default:
      logger.warn('Неизвестный тип сообщения:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

async function handleCheckWord(word) {
  logger.debug('handleCheckWord:', word);
  
  if (!word || word.trim() === '') {
    return { isValid: true, lang: null };
  }
  
  const result = dictManager.checkWordAuto(word.trim());
  logger.debug('Результат проверки:', result);
  
  return result;
}

async function handleGetSuggestions(word) {
  logger.debug('handleGetSuggestions:', word);
  
  if (!word || word.trim() === '') {
    return [];
  }
  
  const suggestions = dictManager.getSuggestionsAuto(word.trim(), 10);
  logger.debug('Подсказки:', suggestions);
  
  return suggestions;
}

async function handleGetStatus() {
  logger.log('handleGetStatus вызван');
  
  const enCount = dictManager.getDictionarySize('en');
  const ruCount = dictManager.getDictionarySize('ru');
  
  const status = {
    loaded: dictManager.loadedLanguages.size > 0,
    enCount,
    ruCount,
    total: enCount + ruCount,
    initialized: initializationComplete,
    error: initializationError ? initializationError.message : null
  };
  
  logger.log('Статус:', status);
  
  return status;
}

async function handleReloadDictionaries() {
  logger.log('handleReloadDictionaries вызван');
  
  try {
    dictManager.dictionaries.clear();
    dictManager.loadedLanguages.clear();
    wordCache.clear();
    initializationComplete = false;
    initializationError = null;
    
    await DictionaryDB.close();
    await loadDictionariesIntoTrie();
    
    initializationComplete = true;
    
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
  logger.log('Создание контекстного меню...');
  
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
  
  logger.log('✓ Контекстное меню создано');
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  logger.log('Клик по меню:', info.menuItemId, 'слово:', info.selectionText);
  
  if (info.menuItemId === 'languagetool-ignore') {
    addWordToIgnore(info.selectionText);
  } else if (info.menuItemId.startsWith('languagetool-replace-')) {
    const replacement = info.menuItemId.replace('languagetool-replace-', '');
    replaceWordInTab(tab.id, info.selectionText, replacement);
  }
});

async function addWordToIgnore(word) {
  logger.log('addWordToIgnore:', word);
  
  const storage = await chrome.storage.local.get(['ignoredWords']);
  const ignoredWords = storage.ignoredWords || [];
  
  if (!ignoredWords.includes(word.toLowerCase())) {
    ignoredWords.push(word.toLowerCase());
    await chrome.storage.local.set({ ignoredWords });
    logger.log(`✓ Слово "${word}" добавлено в исключения`);
  }
}

function replaceWordInTab(tabId, oldWord, newWord) {
  logger.log(`replaceWordInTab: ${tabId}, "${oldWord}" -> "${newWord}"`);
  
  chrome.tabs.sendMessage(tabId, {
    type: 'REPLACE_WORD',
    oldWord,
    newWord
  }, (response) => {
    if (chrome.runtime.lastError) {
      logger.error('Ошибка отправки REPLACE_WORD:', chrome.runtime.lastError);
    } else {
      logger.log('✓ REPLACE_WORD отправлено');
    }
  });
}

// ============================================
// Запуск
// ============================================

logger.log('=== ЗАПУСК BACKGROUND SERVICE WORKER ===');
logger.log('Время запуска:', new Date().toISOString());

createContextMenu();

// Задержка перед инициализацией для стабильности
setTimeout(() => {
  init();
}, 100);

chrome.runtime.onInstalled.addListener((details) => {
  logger.log('onInstalled:', details.reason);
  init();
});

chrome.runtime.onStartup.addListener(() => {
  logger.log('onStartup');
  init();
});
