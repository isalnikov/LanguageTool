/**
 * @fileoverview Trie (префиксное дерево) для быстрой проверки слов
 * Оптимизированная структура данных для работы со словарями
 */

/**
 * Узел Trie дерева
 */
class TrieNode {
  constructor() {
    // Дети узла (символ -> узел)
    this.children = new Map();
    // Флаг конца слова
    this.isEndOfWord = false;
  }
}

/**
 * Класс Trie для эффективной проверки слов и поиска по префиксу
 * Поддерживает быструю проверку существования слова O(m), где m - длина слова
 */
export class Trie {
  constructor() {
    this.root = new TrieNode();
    this.wordCount = 0;
  }

  /**
   * Вставка слова в Trie
   * @param {string} word - слово для вставки
   */
  insert(word) {
    if (!word || word.trim() === '') {
      return;
    }

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

  /**
   * Массовая вставка слов
   * @param {string[]} words - массив слов
   */
  insertBatch(words) {
    for (const word of words) {
      this.insert(word);
    }
  }

  /**
   * Проверка наличия слова в Trie
   * @param {string} word - слово для проверки
   * @returns {boolean}
   */
  has(word) {
    if (!word || word.trim() === '') {
      return false;
    }

    const normalizedWord = word.toLowerCase().trim();
    let node = this.root;

    for (const char of normalizedWord) {
      if (!node.children.has(char)) {
        return false;
      }
      node = node.children.get(char);
    }

    return node.isEndOfWord;
  }

  /**
   * Поиск слов по префиксу
   * @param {string} prefix - префикс для поиска
   * @param {number} limit - максимальное количество результатов
   * @returns {string[]}
   */
  findByPrefix(prefix, limit = 10) {
    if (!prefix || prefix.trim() === '') {
      return [];
    }

    const normalizedPrefix = prefix.toLowerCase().trim();
    let node = this.root;

    // Находим узел, соответствующий префиксу
    for (const char of normalizedPrefix) {
      if (!node.children.has(char)) {
        return [];
      }
      node = node.children.get(char);
    }

    // Собираем все слова с этим префиксом
    const results = [];
    this._collectWords(node, normalizedPrefix, results, limit);
    return results;
  }

  /**
   * Рекурсивный сбор слов из узла
   * @private
   */
  _collectWords(node, prefix, results, limit) {
    if (results.length >= limit) {
      return;
    }

    if (node.isEndOfWord) {
      results.push(prefix);
    }

    // Ограничиваем глубину обхода для производительности
    for (const [char, childNode] of node.children) {
      if (results.length >= limit) {
        break;
      }
      this._collectWords(childNode, prefix + char, results, limit);
    }
  }

  /**
   * Удаление слова из Trie
   * @param {string} word - слово для удаления
   * @returns {boolean}
   */
  delete(word) {
    if (!word || word.trim() === '') {
      return false;
    }

    const normalizedWord = word.toLowerCase().trim();
    const deleted = this._deleteHelper(this.root, normalizedWord, 0);
    if (deleted) {
      this.wordCount--;
    }
    return deleted;
  }

  /**
   * Вспомогательный метод для удаления
   * @private
   */
  _deleteHelper(node, word, index) {
    if (index === word.length) {
      if (!node.isEndOfWord) {
        return false;
      }
      node.isEndOfWord = false;
      return node.children.size === 0;
    }

    const char = word[index];
    const childNode = node.children.get(char);

    if (!childNode) {
      return false;
    }

    const shouldDeleteChild = this._deleteHelper(childNode, word, index + 1);

    if (shouldDeleteChild) {
      node.children.delete(char);
      return !node.isEndOfWord && node.children.size === 0;
    }

    return false;
  }

  /**
   * Получение количества слов в Trie
   * @returns {number}
   */
  size() {
    return this.wordCount;
  }

  /**
   * Очистка Trie
   */
  clear() {
    this.root = new TrieNode();
    this.wordCount = 0;
  }

  /**
   * Сериализация Trie в объект (для сохранения в storage)
   * @returns {Object}
   */
  serialize() {
    return {
      root: this._serializeNode(this.root),
      wordCount: this.wordCount
    };
  }

  /**
   * Сериализация узла
   * @private
   */
  _serializeNode(node) {
    const serialized = {
      isEndOfWord: node.isEndOfWord,
      children: {}
    };

    for (const [char, childNode] of node.children) {
      serialized.children[char] = this._serializeNode(childNode);
    }

    return serialized;
  }

  /**
   * Десериализация Trie из объекта
   * @param {Object} data - сериализованные данные
   */
  deserialize(data) {
    if (!data || !data.root) {
      return;
    }

    this.root = this._deserializeNode(data.root);
    this.wordCount = data.wordCount || 0;
  }

  /**
   * Десериализация узла
   * @private
   */
  _deserializeNode(data) {
    const node = new TrieNode();
    node.isEndOfWord = data.isEndOfWord;

    for (const [char, childData] of Object.entries(data.children || {})) {
      node.children.set(char, this._deserializeNode(childData));
    }

    return node;
  }
}

/**
 * Менеджер словарей с использованием Trie
 * Управляет несколькими словарями (en, ru)
 */
export class DictionaryManager {
  constructor() {
    this.dictionaries = new Map();
    this.loadedLanguages = new Set();
  }

  /**
   * Загрузка словаря для языка
   * @param {string} lang - код языка ('en' или 'ru')
   * @param {string[]} words - массив слов
   */
  loadDictionary(lang, words) {
    console.log(`[DictionaryManager] Загрузка словаря ${lang}: ${words.length} слов`);
    
    const trie = new Trie();
    trie.insertBatch(words);
    
    this.dictionaries.set(lang, trie);
    this.loadedLanguages.add(lang);
    
    console.log(`[DictionaryManager] Словарь ${lang} загружен. Размер: ${trie.size()} слов`);
  }

  /**
   * Проверка слова в словаре
   * @param {string} lang - код языка
   * @param {string} word - слово для проверки
   * @returns {boolean}
   */
  checkWord(lang, word) {
    const trie = this.dictionaries.get(lang);
    if (!trie) {
      console.warn(`[DictionaryManager] Словарь ${lang} не загружен`);
      return false;
    }
    return trie.has(word);
  }

  /**
   * Поиск подсказок по префиксу
   * @param {string} lang - код языка
   * @param {string} prefix - префикс
   * @param {number} limit - лимит результатов
   * @returns {string[]}
   */
  getSuggestions(lang, prefix, limit = 10) {
    const trie = this.dictionaries.get(lang);
    if (!trie) {
      return [];
    }
    return trie.findByPrefix(prefix, limit);
  }

  /**
   * Проверка загруженности словаря
   * @param {string} lang - код языка
   * @returns {boolean}
   */
  isDictionaryLoaded(lang) {
    return this.loadedLanguages.has(lang);
  }

  /**
   * Получение размера словаря
   * @param {string} lang - код языка
   * @returns {number}
   */
  getDictionarySize(lang) {
    const trie = this.dictionaries.get(lang);
    return trie ? trie.size() : 0;
  }

  /**
   * Автоопределение языка слова
   * @param {string} word - слово
   * @returns {string|null}
   */
  detectLanguage(word) {
    // Проверяем наличие кириллицы
    const cyrillicRegex = /[\u0400-\u04FF]/;
    
    if (cyrillicRegex.test(word)) {
      return 'ru';
    }
    
    // Проверяем наличие латиницы
    const latinRegex = /[a-zA-Z]/;
    if (latinRegex.test(word)) {
      return 'en';
    }
    
    return null;
  }

  /**
   * Универсальная проверка слова с автоопределением языка
   * @param {string} word - слово
   * @returns {{isValid: boolean, lang: string|null}}
   */
  checkWordAuto(word) {
    const lang = this.detectLanguage(word);
    if (!lang) {
      return { isValid: true, lang: null }; // Неизвестный язык, считаем верным
    }
    
    const isValid = this.checkWord(lang, word);
    return { isValid, lang };
  }

  /**
   * Получение подсказок с автоопределением языка
   * @param {string} prefix - префикс
   * @param {number} limit - лимит
   * @returns {string[]}
   */
  getSuggestionsAuto(prefix, limit = 10) {
    const lang = this.detectLanguage(prefix);
    if (!lang) {
      return [];
    }
    return this.getSuggestions(lang, prefix, limit);
  }
}

export const dictionaryManager = new DictionaryManager();
