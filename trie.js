/**
 * @fileoverview Trie (префиксное дерево) для быстрой проверки слов
 * Оптимизированная структура данных для работы со словарями
 */

(function(exports) {
  'use strict';

  /**
   * Узел Trie дерева
   */
  class TrieNode {
    constructor() {
      this.children = new Map();
      this.isEndOfWord = false;
    }
  }

  /**
   * Класс Trie для эффективной проверки слов и поиска по префиксу
   */
  class Trie {
    constructor() {
      this.root = new TrieNode();
      this.wordCount = 0;
    }

    /**
     * Вставка слова в Trie
     */
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

    /**
     * Массовая вставка слов
     */
    insertBatch(words) {
      for (const word of words) {
        this.insert(word);
      }
    }

    /**
     * Проверка наличия слова в Trie
     */
    has(word) {
      if (!word || word.trim() === '') return false;

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
     */
    findByPrefix(prefix, limit = 10) {
      if (!prefix || prefix.trim() === '') return [];

      const normalizedPrefix = prefix.toLowerCase().trim();
      let node = this.root;

      for (const char of normalizedPrefix) {
        if (!node.children.has(char)) {
          return [];
        }
        node = node.children.get(char);
      }

      const results = [];
      this._collectWords(node, normalizedPrefix, results, limit);
      return results;
    }

    /**
     * Рекурсивный сбор слов из узла
     */
    _collectWords(node, prefix, results, limit) {
      if (results.length >= limit) return;

      if (node.isEndOfWord) {
        results.push(prefix);
      }

      for (const [char, childNode] of node.children) {
        if (results.length >= limit) break;
        this._collectWords(childNode, prefix + char, results, limit);
      }
    }

    /**
     * Удаление слова из Trie
     */
    delete(word) {
      if (!word || word.trim() === '') return false;

      const normalizedWord = word.toLowerCase().trim();
      const deleted = this._deleteHelper(this.root, normalizedWord, 0);
      if (deleted) this.wordCount--;
      return deleted;
    }

    _deleteHelper(node, word, index) {
      if (index === word.length) {
        if (!node.isEndOfWord) return false;
        node.isEndOfWord = false;
        return node.children.size === 0;
      }

      const char = word[index];
      const childNode = node.children.get(char);

      if (!childNode) return false;

      const shouldDeleteChild = this._deleteHelper(childNode, word, index + 1);

      if (shouldDeleteChild) {
        node.children.delete(char);
        return !node.isEndOfWord && node.children.size === 0;
      }

      return false;
    }

    size() { return this.wordCount; }
    clear() {
      this.root = new TrieNode();
      this.wordCount = 0;
    }
  }

  /**
   * Менеджер словарей с использованием Trie
   */
  class DictionaryManager {
    constructor() {
      this.dictionaries = new Map();
      this.loadedLanguages = new Set();
    }

    /**
     * Загрузка словаря для языка
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
     */
    getSuggestions(lang, prefix, limit = 10) {
      const trie = this.dictionaries.get(lang);
      if (!trie) return [];
      return trie.findByPrefix(prefix, limit);
    }

    /**
     * Проверка загруженности словаря
     */
    isDictionaryLoaded(lang) {
      return this.loadedLanguages.has(lang);
    }

    /**
     * Получение размера словаря
     */
    getDictionarySize(lang) {
      const trie = this.dictionaries.get(lang);
      return trie ? trie.size() : 0;
    }

    /**
     * Автоопределение языка слова
     */
    detectLanguage(word) {
      const cyrillicRegex = /[\u0400-\u04FF]/;
      
      if (cyrillicRegex.test(word)) {
        return 'ru';
      }
      
      const latinRegex = /[a-zA-Z]/;
      if (latinRegex.test(word)) {
        return 'en';
      }
      
      return null;
    }

    /**
     * Универсальная проверка слова с автоопределением языка
     */
    checkWordAuto(word) {
      const lang = this.detectLanguage(word);
      if (!lang) {
        return { isValid: true, lang: null };
      }
      
      const isValid = this.checkWord(lang, word);
      return { isValid, lang };
    }

    /**
     * Получение подсказок с автоопределением языка
     */
    getSuggestionsAuto(prefix, limit = 10) {
      const lang = this.detectLanguage(prefix);
      if (!lang) return [];
      return this.getSuggestions(lang, prefix, limit);
    }
  }

  // Экспорт в глобальный объект
  exports.Trie = Trie;
  exports.DictionaryManager = DictionaryManager;
  
})(window.LanguageTool || (window.LanguageTool = {}));
