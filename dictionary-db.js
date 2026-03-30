/**
 * @fileoverview Модуль работы с IndexedDB для хранения словарей
 * Оптимизирован для работы с большими объёмами данных (2M+ слов)
 */

(function(exports) {
  'use strict';

  const DB_NAME = 'LanguageToolDictDB';
  const DB_VERSION = 1;
  const STORE_NAMES = {
    EN: 'english_words',
    RU: 'russian_words',
    META: 'metadata'
  };

  /**
   * Класс для управления базой данных словарей
   */
  class DictionaryDB {
    constructor() {
      this.db = null;
      this.isOpen = false;
    }

    /**
     * Открывает соединение с IndexedDB
     */
    async open() {
      if (this.isOpen && this.db) {
        return this.db;
      }

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

    /**
     * Массовая вставка слов в хранилище (оптимизированная батчами)
     */
    async bulkInsert(storeName, words, batchSize = 10000) {
      if (!this.db) {
        await this.open();
      }

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

    /**
     * Проверка наличия слова в словаре
     */
    async wordExists(storeName, word) {
      if (!this.db) {
        await this.open();
      }

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index('word');
        const request = index.get(word.toLowerCase());

        request.onsuccess = () => {
          resolve(!!request.result);
        };
        request.onerror = reject;
      });
    }

    /**
     * Поиск слов по префиксу (для подсказок)
     */
    async findWordsByPrefix(storeName, prefix, limit = 10) {
      if (!this.db) {
        await this.open();
      }

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index('word');
        const range = IDBKeyRange.bound(prefix.toLowerCase(), prefix.toLowerCase() + '\uffff');
        
        const results = [];
        const request = index.openCursor();

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value.word);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        request.onerror = reject;
      });
    }

    /**
     * Получение метаданных
     */
    async getMetadata(key) {
      if (!this.db) {
        await this.open();
      }

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([STORE_NAMES.META], 'readonly');
        const store = transaction.objectStore(STORE_NAMES.META);
        const request = store.get(key);

        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = reject;
      });
    }

    /**
     * Сохранение метаданных
     */
    async setMetadata(key, value) {
      if (!this.db) {
        await this.open();
      }

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([STORE_NAMES.META], 'readwrite');
        const store = transaction.objectStore(STORE_NAMES.META);
        const request = store.put({ key, value });

        request.onsuccess = resolve;
        request.onerror = reject;
      });
    }

    /**
     * Проверка загруженности словаря
     */
    async getCount(storeName) {
      if (!this.db) {
        await this.open();
      }

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.count();

        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
    }

    /**
     * Закрытие соединения с БД
     */
    close() {
      if (this.db) {
        this.db.close();
        this.db = null;
        this.isOpen = false;
        console.log('[DictionaryDB] Соединение закрыто');
      }
    }
  }

  // Экспорт в глобальный объект
  exports.DictionaryDB = DictionaryDB;
  exports.dictionaryDB = new DictionaryDB();
  exports.STORE_NAMES = STORE_NAMES;
  
})(window.LanguageTool || (window.LanguageTool = {}));
