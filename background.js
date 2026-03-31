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
// LRUCache - кэш с вытеснением давно неиспользуемых элементов
// ============================================

class LRUCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++;
      return undefined;
    }
    
    // Перемещаем элемент в конец (как недавно использованный)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    this.hits++;
    return value;
  }

  set(key, value) {
    // Если ключ уже есть, удаляем старое значение
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Удаляем самый старый элемент (первый в Map)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    // Добавляем новый элемент в конец
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  size() {
    return this.cache.size;
  }

  // Статистика кэша
  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(2) + '%' : '0%'
    };
  }
}

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
     * Исключает точное совпадение с искомым словом
     */
    findFuzzy(word, limit = 10, maxDistance = 2) {
      if (!word || word.trim() === '') return [];

      const normalizedWord = word.toLowerCase().trim();
      const results = [];

      // Поиск с обходом дерева и вычислением расстояния
      this._fuzzySearch(this.root, '', normalizedWord, maxDistance, results, limit * 3);

      // Фильтруем: убираем точное совпадение с искомым словом
      const filteredResults = results.filter(r => r.word !== normalizedWord);

      // Сортируем по расстоянию Левенштейна (меньше = лучше)
      filteredResults.sort((a, b) => {
        const distA = this._levenshteinDistance(a.word, normalizedWord);
        const distB = this._levenshteinDistance(b.word, normalizedWord);
        return distA - distB;
      });

      // Возвращаем только слова (без расстояния) и ограничиваем лимит
      return filteredResults.slice(0, limit).map(r => r.word);
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
     * Исключает точное совпадение с искомым словом
     */
    findSuggestions(word, limit = 10) {
      if (!word || word.trim() === '') return [];

      const normalizedWord = word.toLowerCase().trim();

      logger.debug(`findSuggestions: "${normalizedWord}"`);

      // Сначала пробуем поиск по префиксу
      const prefixResults = this.findByPrefix(normalizedWord, limit);
      if (prefixResults.length > 0) {
        logger.debug(`  → найдено по префиксу: ${prefixResults.length}`);
        // Фильтруем точное совпадение
        return prefixResults.filter(w => w !== normalizedWord);
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
   * Загрузка словаря для языка с подробным логированием
   */
  async function loadDictionary(lang) {
    const loadStart = Date.now();
    logger.log(`\n${'='.repeat(60)}`);
    logger.log(`📚 ЗАГРУЗКА СЛОВАРЯ: ${lang.toUpperCase()}`);
    logger.log(`⏰ Время начала: ${new Date().toISOString()}`);
    logger.log(`${'='.repeat(60)}`);

    // Проверяем кэш
    if (dictionaryCache.has(lang)) {
      const cachedTime = Date.now() - loadStart;
      logger.log(`✅ КЭШ: Словарь ${lang} уже загружен (${dictionaryCache.get(lang).size()} слов)`);
      logger.log(`⏱️ Время проверки кэша: ${cachedTime}ms`);
      return dictionaryCache.get(lang);
    }

    // Проверяем, не загружается ли уже
    if (loadStatus[lang]?.loading) {
      logger.log(`⏳ Словарь ${lang} уже загружается, ожидаем завершения...`);
      return waitForLoad(lang);
    }

    loadStatus[lang].loading = true;
    loadStatus[lang].error = null;

    try {
      // Загружаем из файла
      const url = chrome.runtime.getURL(`vocab/${lang}/words.txt`);
      logger.log(`📂 URL словаря: ${url}`);

      // === ЗАГРУЗКА ФАЙЛА ===
      const fetchStart = Date.now();
      const response = await fetch(url);
      const fetchTime = Date.now() - fetchStart;

      logger.log(`\n📥 ЭТАП 1: Загрузка файла`);
      logger.log(`   📡 Статус ответа: ${response.status} ${response.statusText}`);
      logger.log(`   ⏱️ Время загрузки: ${fetchTime}ms (${(fetchTime / 1000).toFixed(2)} сек)`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // === ПАРСИНГ ТЕКСТА ===
      const parseStart = Date.now();
      const text = await response.text();
      const parseTime = Date.now() - parseStart;

      logger.log(`\n📥 ЭТАП 2: Чтение текста`);
      logger.log(`   📄 Размер текста: ${(text.length / 1024 / 1024).toFixed(2)} MB (${text.length.toLocaleString()} символов)`);
      logger.log(`   ⏱️ Время чтения: ${parseTime}ms`);

      // === РАЗБИВКА НА СЛОВА ===
      const splitStart = Date.now();
      const words = text.split('\n')
        .map(w => w.toLowerCase().trim())
        .filter(w => w.length > 0);
      const splitTime = Date.now() - splitStart;

      logger.log(`\n📥 ЭТАП 3: Разбивка на слова`);
      logger.log(`   📊 Всего слов: ${words.length.toLocaleString()}`);
      logger.log(`   ⏱️ Время разбивки: ${splitTime}ms`);

      // === УДАЛЕНИЕ ДУПЛИКАТОВ ===
      const uniqueStart = Date.now();
      const uniqueWords = [...new Set(words)];
      const uniqueTime = Date.now() - uniqueStart;

      const duplicates = words.length - uniqueWords.length;
      logger.log(`\n📥 ЭТАП 4: Удаление дубликатов`);
      logger.log(`   ✨ Уникальных слов: ${uniqueWords.length.toLocaleString()}`);
      logger.log(`   🗑️ Удалено дубликатов: ${duplicates.toLocaleString()} (${(duplicates / words.length * 100).toFixed(1)}%)`);
      logger.log(`   ⏱️ Время удаления: ${uniqueTime}ms`);

      // === СОЗДАНИЕ TRIE С ПРОГРЕССОМ ===
      logger.log(`\n📥 ЭТАП 5: Построение Trie дерева`);
      const trieStart = Date.now();
      const trie = new Trie();
      
      // Вставляем слова батчами с логированием прогресса
      const batchSize = 10000;
      let insertedCount = 0;
      
      for (let i = 0; i < uniqueWords.length; i += batchSize) {
        const batchStart = Date.now();
        const batch = uniqueWords.slice(i, i + batchSize);
        const batchInserted = trie.insertBatch(batch);
        insertedCount += batchInserted;
        const batchTime = Date.now() - batchStart;
        
        const progress = ((i + batch.length) / uniqueWords.length * 100).toFixed(1);
        const wordsPerSec = (batchInserted / batchTime * 1000).toFixed(0);
        
        logger.log(`   📊 Прогресс: ${progress}% (${insertedCount.toLocaleString()}/${uniqueWords.length.toLocaleString()} слов) за ${batchTime}ms (${wordsPerSec} слов/сек)`);
      }
      
      const trieTime = Date.now() - trieStart;

      logger.log(`\n✅ Trie дерево построено`);
      logger.log(`   ✓ Вставлено слов: ${insertedCount.toLocaleString()}`);
      logger.log(`   ⏱️ Общее время построения: ${trieTime}ms (${(trieTime / 1000).toFixed(2)} сек)`);
      logger.log(`   ⚡ Средняя скорость: ${(insertedCount / trieTime * 1000).toFixed(0)} слов/сек`);

      // Кэшируем
      dictionaryCache.set(lang, trie);
      loadStatus[lang].loaded = true;
      loadStatus[lang].wordCount = insertedCount;
      loadStatus[lang].loading = false;

      const totalTime = Date.now() - loadStart;

      logger.log(`\n${'='.repeat(60)}`);
      logger.log(`✅ СЛОВАРЬ ${lang.toUpperCase()} УСПЕШНО ЗАГРУЖЕН`);
      logger.log(`${'='.repeat(60)}`);
      logger.log(`📈 ИТОГОВАЯ СТАТИСТИКА:`);
      logger.log(`   • Слов в словаре: ${insertedCount.toLocaleString()}`);
      logger.log(`   • Размер в памяти: ~${(insertedCount * 50 / 1024 / 1024).toFixed(2)} MB (оценка)`);
      logger.log(`   • Общее время загрузки: ${totalTime}ms (${(totalTime / 1000).toFixed(2)} сек)`);
      logger.log(`   • Средняя скорость: ${(insertedCount / totalTime * 1000).toFixed(0)} слов/сек`);
      logger.log(`\n⏱️ ДЕТАЛИЗАЦИЯ ПО ЭТАПАМ:`);
      logger.log(`   • Загрузка файла: ${fetchTime}ms (${((fetchTime / totalTime) * 100).toFixed(1)}%)`);
      logger.log(`   • Чтение текста: ${parseTime}ms (${((parseTime / totalTime) * 100).toFixed(1)}%)`);
      logger.log(`   • Разбивка на слова: ${splitTime}ms (${((splitTime / totalTime) * 100).toFixed(1)}%)`);
      logger.log(`   • Удаление дубликатов: ${uniqueTime}ms (${((uniqueTime / totalTime) * 100).toFixed(1)}%)`);
      logger.log(`   • Построение Trie: ${trieTime}ms (${((trieTime / totalTime) * 100).toFixed(1)}%)`);
      logger.log(`${'='.repeat(60)}\n`);

      return trie;

    } catch (error) {
      const totalTime = Date.now() - loadStart;
      logger.error(`\n${'='.repeat(60)}`);
      logger.error(`❌ ОШИБКА ЗАГРУЗКИ СЛОВАРЯ ${lang.toUpperCase()}`);
      logger.error(`⏱️ Прошло времени: ${totalTime}ms`);
      logger.error(`Ошибка:`, error.message);
      logger.error(`Stack:`, error.stack);
      logger.error(`${'='.repeat(60)}\n`);
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
   * Предварительная загрузка обоих словарей с логированием
   */
  async function preloadAll() {
    const preloadStart = Date.now();
    logger.log(`\n${'='.repeat(60)}`);
    logger.log(`🚀 ПРЕДВАРИТЕЛЬНАЯ ЗАГРУЗКА ВСЕХ СЛОВАРЕЙ`);
    logger.log(`⏰ Время начала: ${new Date().toISOString()}`);
    logger.log(`${'='.repeat(60)}`);

    const results = await Promise.allSettled([
      loadDictionary('en').catch(e => ({ error: e.message })),
      loadDictionary('ru').catch(e => ({ error: e.message }))
    ]);

    const totalTime = Date.now() - preloadStart;

    logger.log(`\n${'='.repeat(60)}`);
    logger.log(`✅ ПРЕДВАРИТЕЛЬНАЯ ЗАГРУЗКА ЗАВЕРШЕНА`);
    logger.log(`⏱️ Общее время: ${totalTime}ms (${(totalTime / 1000).toFixed(2)} сек)`);
    logger.log(`${'='.repeat(60)}`);
    
    logger.log('\n📊 Результаты загрузки:');
    
    const enResult = results[0];
    const ruResult = results[1];
    
    if (enResult.status === 'fulfilled') {
      logger.log(`   🇬🇧 EN: ✓ ${enResult.value.size()} слов`);
    } else {
      logger.error(`   🇬🇧 EN: ✗ Ошибка: ${enResult.reason?.error}`);
    }
    
    if (ruResult.status === 'fulfilled') {
      logger.log(`   🇷🇺 RU: ✓ ${ruResult.value.size()} слов`);
    } else {
      logger.error(`   🇷🇺 RU: ✗ Ошибка: ${ruResult.reason?.error}`);
    }

    return {
      en: enResult.status === 'fulfilled' ? enResult.value.size() : null,
      ru: ruResult.status === 'fulfilled' ? ruResult.value.size() : null
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
// SpellChecker - проверка слов с логированием и LRU кэшем
// ============================================

const SpellChecker = (function() {
  // LRU кэш для часто используемых слов (10000 слов)
  const wordCache = new LRUCache(10000);
  
  // Кэш для подсказок (5000 запросов)
  const suggestionsCache = new LRUCache(5000);
  
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
   * Проверка слова с кэшированием
   */
  async function checkWord(word) {
    const startTime = Date.now();
    const normalizedWord = word.trim().toLowerCase();
    const lang = detectLanguage(normalizedWord);
    
    if (!lang) {
      return { isValid: true, lang: null };
    }
    
    // Проверяем LRU кэш первым делом
    const cachedResult = wordCache.get(normalizedWord);
    if (cachedResult !== undefined) {
      const duration = Date.now() - startTime;
      logger.log(`✓ [LRU HIT] "${normalizedWord}" (${lang}): ${cachedResult ? 'ВЕРНО' : 'ОШИБКА'} за ${duration}ms`);
      return { isValid: cachedResult, lang };
    }
    
    if (!DictionaryLoader.isLoaded(lang)) {
      const loadStart = Date.now();
      logger.log(`📚 Словарь ${lang} не загружен, начинаем загрузку...`);
      await DictionaryLoader.loadDictionary(lang);
      logger.log(`⏱️ Время загрузки словаря ${lang}: ${Date.now() - loadStart}ms`);
    }

    const trie = DictionaryLoader.getTrie(lang);
    if (!trie) {
      logger.warn(`Trie для ${lang} не найден`);
      return { isValid: true, lang: null };
    }

    const checkStart = Date.now();
    const isValid = trie.has(normalizedWord);
    const checkTime = Date.now() - checkStart;
    
    // Сохраняем результат в LRU кэш
    wordCache.set(normalizedWord, isValid);
    
    const totalTime = Date.now() - startTime;
    
    logger.log(`✓ Проверка "${normalizedWord}" (${lang}): ${isValid ? '✓ ВЕРНО' : '✗ ОШИБКА'} | Общее время: ${totalTime}ms, проверка: ${checkTime}ms`);

    return { isValid, lang };
  }

  /**
   * Получение подсказок с кэшированием
   */
  async function getSuggestions(word, limit = 10) {
    const startTime = Date.now();
    
    if (!word || word.trim() === '') {
      logger.log(`⏱️ getSuggestions: пустое слово, возврат [] за ${Date.now() - startTime}ms`);
      return [];
    }

    const prefix = word.trim().toLowerCase();
    const lang = detectLanguage(prefix);
    
    if (!lang) {
      logger.log(`⏱️ getSuggestions: не определён язык для "${prefix}", возврат [] за ${Date.now() - startTime}ms`);
      return [];
    }
    
    // Проверяем кэш подсказок
    const cachedSuggestions = suggestionsCache.get(prefix);
    if (cachedSuggestions !== undefined) {
      const duration = Date.now() - startTime;
      logger.log(`💡 [LRU HIT] Подсказки для "${prefix}" (${lang}): найдено ${cachedSuggestions.length} слов за ${duration}ms (из кэша)`);
      if (cachedSuggestions.length > 0) {
        logger.log(`   Варианты: [${cachedSuggestions.slice(0, 5).join(', ')}${cachedSuggestions.length > 5 ? '...' : ''}]`);
      }
      return cachedSuggestions;
    }

    // Проверяем, загружен ли словарь
    let loadTime = 0;
    if (!DictionaryLoader.isLoaded(lang)) {
      const loadStart = Date.now();
      logger.log(`📚 Словарь ${lang} не загружен, загружаем для подсказок...`);
      await DictionaryLoader.loadDictionary(lang);
      loadTime = Date.now() - loadStart;
      logger.log(`⏱️ Время загрузки словаря ${lang}: ${loadTime}ms`);
    }

    const trie = DictionaryLoader.getTrie(lang);
    if (!trie) {
      logger.warn(`Trie для ${lang} не найден`);
      return [];
    }

    // Умный поиск: префикс + нечёткий
    const searchStart = Date.now();
    let suggestions = trie.findSuggestions(prefix.toLowerCase(), limit);
    const searchTime = Date.now() - searchStart;

    // Дополнительная фильтрация: убираем точное совпадение с исходным словом
    suggestions = suggestions.filter(s => s !== prefix.toLowerCase());

    // Сохраняем в кэш подсказок
    suggestionsCache.set(prefix, suggestions);

    const totalTime = Date.now() - startTime;

    logger.log(`💡 Подсказки для "${prefix}" (${lang}): найдено ${suggestions.length} слов за ${totalTime}ms${loadTime > 0 ? ` (загрузка: ${loadTime}ms, поиск: ${searchTime}ms)` : `, поиск: ${searchTime}ms`}`);

    if (suggestions.length > 0) {
      logger.log(`   Варианты: [${suggestions.slice(0, 5).join(', ')}${suggestions.length > 5 ? '...' : ''}]`);
    }

    return suggestions;
  }

  return {
    checkWord,
    getSuggestions
  };
})();

// ============================================
// Обработчики сообщений с логированием времени
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msgStart = Date.now();
  logger.log(`\n← Сообщение: ${message.type} от: ${sender.tab ? 'tab' : 'popup'}`);

  switch (message.type) {
    case 'CHECK_WORD':
      SpellChecker.checkWord(message.word)
        .then(result => {
          const duration = Date.now() - msgStart;
          logger.log(`→ CHECK_WORD: ${result.isValid ? '✓' : '✗'} | Общее время запроса: ${duration}ms`);
          sendResponse(result);
        })
        .catch(err => {
          const duration = Date.now() - msgStart;
          logger.error(`→ CHECK_WORD: Ошибка за ${duration}ms:`, err.message);
          sendResponse({ isValid: false, error: err.message });
        });
      return true;

    case 'GET_SUGGESTIONS':
      SpellChecker.getSuggestions(message.word, message.limit || 10)
        .then(result => {
          const duration = Date.now() - msgStart;
          logger.log(`→ GET_SUGGESTIONS: ${result.length} предложений за ${duration}ms`);
          sendResponse(result);
        })
        .catch(err => {
          const duration = Date.now() - msgStart;
          logger.error(`→ GET_SUGGESTIONS: Ошибка за ${duration}ms:`, err.message);
          sendResponse([]);
        });
      return true;

    case 'GET_STATUS':
      const status = DictionaryLoader.getStatus();
      logger.log(`→ GET_STATUS: ${status.totalLoaded} слов загружено`);
      sendResponse(status);
      return true;

    case 'PRELOAD_ALL':
      logger.log('→ PRELOAD_ALL: Начинаем предварительную загрузку всех словарей...');
      DictionaryLoader.preloadAll()
        .then(result => {
          logger.log(`→ PRELOAD_ALL: Завершено за ${Date.now() - msgStart}ms`, result);
          sendResponse(result);
        })
        .catch(err => {
          logger.error(`→ PRELOAD_ALL: Ошибка за ${Date.now() - msgStart}ms:`, err.message);
          sendResponse({ error: err.message });
        });
      return true;

    case 'CLEAR_CACHE':
      DictionaryLoader.clearCache();
      logger.log('→ CLEAR_CACHE: Кэш словарей очищен');
      sendResponse({ success: true });
      return true;

    case 'GET_CACHE_STATS':
      const stats = {
        words: wordCache.getStats(),
        suggestions: suggestionsCache.getStats()
      };
      logger.log(`→ GET_CACHE_STATS:`, stats);
      sendResponse(stats);
      return true;

    case 'CLEAR_LRU_CACHE':
      wordCache.clear();
      suggestionsCache.clear();
      logger.log('→ CLEAR_LRU_CACHE: LRU кэш очищен');
      sendResponse({ success: true });
      return true;

    case 'GET_LOGS':
      logger.getLogs().then(logs => {
        logger.log(`→ GET_LOGS: ${logs.length} записей`);
        sendResponse(logs);
      });
      return true;

    case 'CLEAR_LOGS':
      logger.clearLogs().then(() => {
        logger.log('→ CLEAR_LOGS: Логи очищены');
        sendResponse({ success: true });
      });
      return true;

    default:
      logger.warn(`Неизвестный тип сообщения: ${message.type}`);
      sendResponse({ error: 'Unknown message type' });
  }
});

// ============================================
// Контекстное меню
// ============================================

function createContextMenu() {
  logger.log('Создание контекстного меню...');

  // Сначала удаляем старые пункты меню (чтобы избежать дубликатов)
  chrome.contextMenus.removeAll(() => {
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
  });
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
