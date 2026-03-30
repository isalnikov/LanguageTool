/**
 * @fileoverview Background Service Worker для Chrome Extension
 * ЛЕНИВАЯ ЗАГРУЗКА СЛОВАРЕЙ - загрузка только по требованию
 * КЭШИРОВАНИЕ - сохранение загруженных слов в памяти
 * 
 * АЛГОРИТМ:
 * 1. При старте загружаем только метаданные (количество слов)
 * 2. При проверке слова - загружаем соответствующий язык
 * 3. Кэшируем загруженные словари в памяти
 * 4. Повторная проверка использует кэш
 */

'use strict';

// ============================================
// Logger
// ============================================

const Logger = (function() {
  const LEVELS = { DEBUG: 0, LOG: 1, INFO: 2, WARN: 3, ERROR: 4 };
  
  class Logger {
    constructor(context = 'app') {
      this.context = context;
      this.enabled = true;
      this.logLevel = LEVELS.DEBUG;
      this.maxStoredLogs = 500;
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
        console.error('[Logger] Ошибка сохранения:', error);
      }
    }

    async logMessage(level, ...args) {
      if (!this.enabled) return;
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
    }
  }
  
  return Logger;
})();

const logger = new Logger('background');

// ============================================
// Trie с нечётким поиском
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
      let count = 0;
      for (const word of words) {
        const before = this.wordCount;
        this.insert(word);
        if (this.wordCount > before) count++;
      }
      return count;
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

    /**
     * Поиск по префиксу (базовый метод)
     */
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

    /**
     * Нечёткий поиск слов с опечатками
     * Ищет слова с расстоянием Левенштейна <= maxDistance
     * Возвращает результаты отсортированные по расстоянию (лучшие первыми)
     */
    findFuzzy(word, limit = 10, maxDistance = 2) {
      if (!word || word.trim() === '') return [];
      
      const normalizedWord = word.toLowerCase().trim();
      const results = [];
      
      // Поиск с обходом дерева и вычислением расстояния
      this._fuzzySearch(this.root, '', normalizedWord, maxDistance, results, limit * 3);
      
      // Сортируем по расстоянию Левенштейна (меньше = лучше)
      results.sort((a, b) => {
        const distA = this._levenshteinDistance(a.word, normalizedWord);
        const distB = this._levenshteinDistance(b.word, normalizedWord);
        return distA - distB;
      });
      
      // Возвращаем только слова (без расстояния) и ограничиваем лимит
      return results.slice(0, limit).map(r => r.word);
    }

    _fuzzySearch(node, currentWord, targetWord, maxDistance, results, maxResults) {
      if (results.length >= maxResults) return;
      
      // Если это конец слова и расстояние небольшое - добавляем
      if (node.isEndOfWord) {
        const distance = this._levenshteinDistance(currentWord, targetWord);
        if (distance <= maxDistance) {
          results.push({ word: currentWord, distance });
        }
      }
      
      // Продолжаем обход если текущее расстояние ещё позволяет
      if (currentWord.length - targetWord.length <= maxDistance) {
        for (const [char, childNode] of node.children) {
          this._fuzzySearch(childNode, currentWord + char, targetWord, maxDistance, results, maxResults);
        }
      }
    }

    /**
     * Расстояние Левенштейна
     */
    _levenshteinDistance(s1, s2) {
      const m = s1.length;
      const n = s2.length;
      
      // Оптимизация для очень разных по длине слов
      if (Math.abs(m - n) > 2) return Math.max(m, n);
      
      const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
      
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,      // удаление
            dp[i][j - 1] + 1,      // вставка
            dp[i - 1][j - 1] + cost // замена
          );
          // Транспозиция (для соседних переставленных букв)
          if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
            dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
          }
        }
      }
      
      return dp[m][n];
    }

    /**
     * Умный поиск: сначала по префиксу, потом нечёткий
     */
    findSuggestions(word, limit = 10) {
      if (!word || word.trim() === '') return [];
      
      const normalizedWord = word.toLowerCase().trim();
      
      logger.debug(`findSuggestions: "${normalizedWord}"`);
      
      // Сначала пробуем поиск по префиксу
      const prefixResults = this.findByPrefix(normalizedWord, limit);
      if (prefixResults.length > 0) {
        logger.debug(`  → найдено по префиксу: ${prefixResults.length}`);
        return prefixResults;
      }
      
      // Если не найдено - нечёткий поиск
      logger.debug(`  → поиск по префиксу не дал результатов, используем fuzzy...`);
      const fuzzyResults = this.findFuzzy(normalizedWord, limit, 2);
      logger.debug(`  → найдено fuzzy: ${fuzzyResults.length}`, fuzzyResults);
      return fuzzyResults;
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
// DictionaryLoader - ленивая загрузка словарей
// ============================================

const DictionaryLoader = (function() {
  // Кэш загруженных словарей
  const dictionaryCache = new Map();
  
  // Статус загрузки
  const loadStatus = {
    en: { loaded: false, loading: false, error: null, wordCount: 0 },
    ru: { loaded: false, loading: false, error: null, wordCount: 0 }
  };
  
  // Trie для каждого языка
  const tries = new Map();

  /**
   * Загрузка словаря для языка
   */
  async function loadDictionary(lang) {
    const loadStart = Date.now();
    logger.log(`\n=== ЗАГРУЗКА СЛОВАРЯ: ${lang} ===`);
    logger.log(`Время начала: ${new Date().toISOString()}`);
    
    // Проверяем кэш
    if (dictionaryCache.has(lang)) {
      logger.log(`✓ Словарь ${lang} уже в кэше (${dictionaryCache.get(lang).size()} слов)`);
      return dictionaryCache.get(lang);
    }
    
    // Проверяем, не загружается ли уже
    if (loadStatus[lang]?.loading) {
      logger.log(`⏳ Словарь ${lang} уже загружается, ждем...`);
      return waitForLoad(lang);
    }
    
    loadStatus[lang].loading = true;
    loadStatus[lang].error = null;
    
    try {
      // Загружаем из файла
      const url = chrome.runtime.getURL(`vocab/${lang}/words.txt`);
      logger.log(`📂 URL словаря: ${url}`);
      
      const fetchStart = Date.now();
      const response = await fetch(url);
      const fetchTime = Date.now() - fetchStart;
      
      logger.log(`📡 Статус ответа: ${response.status} ${response.statusText}`);
      logger.log(`⏱️ Время загрузки: ${fetchTime}ms`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const parseStart = Date.now();
      const text = await response.text();
      const parseTime = Date.now() - parseStart;
      
      logger.log(`📄 Размер текста: ${(text.length / 1024 / 1024).toFixed(2)} MB (${text.length.toLocaleString()} символов)`);
      logger.log(`⏱️ Время парсинга: ${parseTime}ms`);
      
      // Разбиваем на слова и удаляем дубликаты
      const splitStart = Date.now();
      const words = text.split('\n')
        .map(w => w.toLowerCase().trim())
        .filter(w => w.length > 0);
      const splitTime = Date.now() - splitStart;
      
      logger.log(`📊 Всего слов: ${words.length.toLocaleString()}`);
      logger.log(`⏱️ Время разбивки: ${splitTime}ms`);
      
      // Удаляем дубликаты через Set
      const uniqueStart = Date.now();
      const uniqueWords = [...new Set(words)];
      const uniqueTime = Date.now() - uniqueStart;
      
      const duplicates = words.length - uniqueWords.length;
      logger.log(`✨ Уникальных слов: ${uniqueWords.length.toLocaleString()}`);
      logger.log(`🗑️ Удалено дубликатов: ${duplicates.toLocaleString()} (${(duplicates / words.length * 100).toFixed(1)}%)`);
      logger.log(`⏱️ Время удаления дубликатов: ${uniqueTime}ms`);
      
      // Создаём Trie
      logger.log('🌳 Создание Trie дерева...');
      const trieStart = Date.now();
      const trie = new Trie();
      const inserted = trie.insertBatch(uniqueWords);
      const trieTime = Date.now() - trieStart;
      
      logger.log(`✓ Вставлено в Trie: ${inserted.toLocaleString()} слов`);
      logger.log(`⏱️ Время создания Trie: ${trieTime}ms (${(inserted / trieTime * 1000).toFixed(0)} слов/сек)`);
      
      // Кэшируем
      dictionaryCache.set(lang, trie);
      loadStatus[lang].loaded = true;
      loadStatus[lang].wordCount = inserted;
      loadStatus[lang].loading = false;
      
      const totalTime = Date.now() - loadStart;
      
      logger.log(`\n✅ СЛОВАРЬ ${lang.toUpperCase()} ЗАГРУЖЕН`);
      logger.log(`📈 Статистика:`);
      logger.log(`   • Слов в словаре: ${inserted.toLocaleString()}`);
      logger.log(`   • Размер в памяти: ~${(inserted * 50 / 1024 / 1024).toFixed(2)} MB (оценка)`);
      logger.log(`   • Общее время: ${totalTime}ms`);
      logger.log(`   • Средняя скорость: ${(inserted / totalTime * 1000).toFixed(0)} слов/сек\n`);
      
      return trie;
      
    } catch (error) {
      logger.error(`\n❌ ОШИБКА ЗАГРУЗКИ СЛОВАРЯ ${lang}`);
      logger.error(`Ошибка:`, error.message);
      logger.error(`Stack:`, error.stack);
      loadStatus[lang].error = error.message;
      loadStatus[lang].loading = false;
      throw error;
    }
  }
  
  /**
   * Ожидание завершения загрузки
   */
  async function waitForLoad(lang) {
    const maxWait = 30000; // 30 секунд
    const interval = 100;
    let waited = 0;
    
    while (loadStatus[lang].loading && waited < maxWait) {
      await new Promise(r => setTimeout(r, interval));
      waited += interval;
    }
    
    if (loadStatus[lang].loading) {
      throw new Error(`Timeout waiting for ${lang} dictionary`);
    }
    
    if (loadStatus[lang].error) {
      throw new Error(loadStatus[lang].error);
    }
    
    return dictionaryCache.get(lang);
  }
  
  /**
   * Проверка наличия словаря в кэше
   */
  function isLoaded(lang) {
    return loadStatus[lang]?.loaded === true;
  }
  
  /**
   * Проверка загрузки
   */
  function isLoading(lang) {
    return loadStatus[lang]?.loading === true;
  }
  
  /**
   * Получение Trie
   */
  function getTrie(lang) {
    return dictionaryCache.get(lang);
  }
  
  /**
   * Статус загрузки
   */
  function getStatus() {
    return {
      en: { ...loadStatus.en },
      ru: { ...loadStatus.ru },
      totalLoaded: loadStatus.en.wordCount + loadStatus.ru.wordCount
    };
  }
  
  /**
   * Предварительная загрузка обоих словарей
   */
  async function preloadAll() {
    logger.log('=== ПРЕДВАРИТЕЛЬНАЯ ЗАГРУЗКА ВСЕХ СЛОВАРЕЙ ===');
    
    const results = await Promise.allSettled([
      loadDictionary('en').catch(e => ({ error: e.message })),
      loadDictionary('ru').catch(e => ({ error: e.message }))
    ]);
    
    logger.log('Результаты загрузки:');
    logger.log('  EN:', results[0].status === 'fulfilled' ? 
      `${results[0].value.size()} слов` : `Ошибка: ${results[0].reason?.error}`);
    logger.log('  RU:', results[1].status === 'fulfilled' ? 
      `${results[1].value.size()} слов` : `Ошибка: ${results[1].reason?.error}`);
    
    return {
      en: results[0].status === 'fulfilled' ? results[0].value.size() : null,
      ru: results[1].status === 'fulfilled' ? results[1].value.size() : null
    };
  }
  
  /**
   * Очистка кэша
   */
  function clearCache() {
    dictionaryCache.clear();
    loadStatus.en = { loaded: false, loading: false, error: null, wordCount: 0 };
    loadStatus.ru = { loaded: false, loading: false, error: null, wordCount: 0 };
    logger.log('Кэш словарей очищен');
  }
  
  return {
    loadDictionary,
    isLoaded,
    isLoading,
    getTrie,
    getStatus,
    preloadAll,
    clearCache
  };
})();

// ============================================
// SpellChecker - проверка слов
// ============================================

const SpellChecker = (function() {
  /**
   * Автоопределение языка
   */
  function detectLanguage(word) {
    const cyrillicRegex = /[\u0400-\u04FF]/;
    if (cyrillicRegex.test(word)) return 'ru';
    const latinRegex = /[a-zA-Z]/;
    if (latinRegex.test(word)) return 'en';
    return null;
  }
  
  /**
   * Проверка слова
   */
  async function checkWord(word) {
    if (!word || word.trim() === '') {
      return { isValid: true, lang: null };
    }
    
    const normalizedWord = word.trim();
    const lang = detectLanguage(normalizedWord);
    
    if (!lang) {
      return { isValid: true, lang: null };
    }
    
    // Проверяем, загружен ли словарь
    if (!DictionaryLoader.isLoaded(lang)) {
      logger.log(`Словарь ${lang} не загружен, загружаем...`);
      await DictionaryLoader.loadDictionary(lang);
    }
    
    const trie = DictionaryLoader.getTrie(lang);
    if (!trie) {
      logger.warn(`Trie для ${lang} не найден`);
      return { isValid: true, lang: null };
    }
    
    const isValid = trie.has(normalizedWord);
    logger.debug(`Проверка "${normalizedWord}" (${lang}): ${isValid ? '✓' : '✗'}`);
    
    return { isValid, lang };
  }
  
  /**
   * Получение подсказок с нечётким поиском
   */
  async function getSuggestions(word, limit = 10) {
    if (!word || word.trim() === '') {
      return [];
    }
    
    const prefix = word.trim();
    const lang = detectLanguage(prefix);
    
    if (!lang) {
      return [];
    }
    
    // Проверяем, загружен ли словарь
    if (!DictionaryLoader.isLoaded(lang)) {
      logger.log(`Словарь ${lang} не загружен, загружаем для подсказок...`);
      await DictionaryLoader.loadDictionary(lang);
    }
    
    const trie = DictionaryLoader.getTrie(lang);
    if (!trie) {
      return [];
    }
    
    // Умный поиск: префикс + нечёткий
    const startTime = Date.now();
    const suggestions = trie.findSuggestions(prefix.toLowerCase(), limit);
    const duration = Date.now() - startTime;
    
    logger.log(`findSuggestions("${prefix}", ${lang}): ${duration}ms, найдено: ${suggestions.length}`);
    
    return suggestions;
  }
  
  return {
    checkWord,
    getSuggestions
  };
})();

// ============================================
// Обработчики сообщений
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.log('← Сообщение:', message.type, 'от:', sender.tab ? 'tab' : 'popup');
  
  switch (message.type) {
    case 'CHECK_WORD':
      SpellChecker.checkWord(message.word)
        .then(result => {
          logger.debug('→ CHECK_WORD:', result);
          sendResponse(result);
        })
        .catch(err => {
          logger.error('Ошибка CHECK_WORD:', err);
          sendResponse({ isValid: false, error: err.message });
        });
      return true;
    
    case 'GET_SUGGESTIONS':
      SpellChecker.getSuggestions(message.word)
        .then(result => {
          logger.debug('→ GET_SUGGESTIONS:', result.length, 'предложений');
          sendResponse(result);
        })
        .catch(err => {
          logger.error('Ошибка GET_SUGGESTIONS:', err);
          sendResponse([]);
        });
      return true;
    
    case 'GET_STATUS':
      const status = DictionaryLoader.getStatus();
      logger.log('→ GET_STATUS:', status);
      sendResponse(status);
      return true;
    
    case 'PRELOAD_ALL':
      DictionaryLoader.preloadAll()
        .then(result => {
          logger.log('→ PRELOAD_ALL:', result);
          sendResponse(result);
        })
        .catch(err => {
          logger.error('Ошибка PRELOAD_ALL:', err);
          sendResponse({ error: err.message });
        });
      return true;
    
    case 'CLEAR_CACHE':
      DictionaryLoader.clearCache();
      logger.log('→ CLEAR_CACHE: кэш очищен');
      sendResponse({ success: true });
      return true;
    
    case 'GET_LOGS':
      logger.getLogs().then(logs => {
        logger.log('→ GET_LOGS:', logs.length, 'записей');
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

// ============================================
// Запуск
// ============================================

logger.log('=== ЗАПУСК BACKGROUND SERVICE WORKER ===');
logger.log('Время:', new Date().toISOString());
logger.log('User Agent:', navigator.userAgent);

createContextMenu();

// НЕ загружаем словари при старте!
// Загрузка происходит по требованию при первой проверке слова

logger.log('=== ГОТОВ К РАБОТЕ (ленивая загрузка) ===');

chrome.runtime.onInstalled.addListener((details) => {
  logger.log('onInstalled:', details.reason);
  // Предварительная загрузка после установки
  if (details.reason === 'install') {
    setTimeout(() => DictionaryLoader.preloadAll(), 1000);
  }
});

chrome.runtime.onStartup.addListener(() => {
  logger.log('onStartup - словари будут загружены по требованию');
});
