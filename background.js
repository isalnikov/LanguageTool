/**
 * @fileoverview Background Service Worker для Chrome Extension
 * Управляет загрузкой словарей, обработкой запросов и контекстным меню
 */

import { dictionaryDB } from './dictionary-db.js';
import { Trie, DictionaryManager } from './trie.js';
import { Logger } from './logger.js';

const logger = new Logger('background');

// Глобальный менеджер словарей
const dictManager = new DictionaryManager();

// Кэш для хранения загруженных слов
const wordCache = new Map();

/**
 * Инициализация расширения
 */
async function init() {
  logger.log('Инициализация LanguageTool Offline...');
  
  try {
    // Открываем IndexedDB
    await dictionaryDB.open();
    logger.log('IndexedDB открыта');
    
    // Проверяем, загружены ли словари в IndexedDB
    const enCount = await dictionaryDB.getCount('english_words');
    const ruCount = await dictionaryDB.getCount('russian_words');
    
    logger.log(`Словари в IndexedDB: en=${enCount}, ru=${ruCount}`);
    
    // Если словари пусты, загружаем их из файлов
    if (enCount === 0 || ruCount === 0) {
      logger.log('Словари пусты, начинаем загрузку...');
      await loadDictionariesFromFiles();
    } else {
      // Загружаем словари в Trie для быстрой работы
      await loadDictionariesIntoTrie();
    }
    
    logger.log('Инициализация завершена');
  } catch (error) {
    logger.error('Ошибка инициализации:', error);
  }
}

/**
 * Загрузка словарей из файлов vocab/
 */
async function loadDictionariesFromFiles() {
  try {
    // Загружаем английский словарь
    logger.log('Загрузка английского словаря...');
    const enResponse = await fetch(chrome.runtime.getURL('vocab/en/words.txt'));
    const enText = await enResponse.text();
    const enWords = enText.split('\n').filter(w => w.trim());
    
    await dictionaryDB.bulkInsert('english_words', enWords);
    logger.log(`Английский словарь загружен: ${enWords.length} слов`);
    
    // Загружаем русский словарь
    logger.log('Загрузка русского словаря...');
    const ruResponse = await fetch(chrome.runtime.getURL('vocab/ru/words.txt'));
    const ruText = await ruResponse.text();
    const ruWords = ruText.split('\n').filter(w => w.trim());
    
    await dictionaryDB.bulkInsert('russian_words', ruWords);
    logger.log(`Русский словарь загружен: ${ruWords.length} слов`);
    
    // После загрузки в DB, загружаем в Trie
    await loadDictionariesIntoTrie();
    
  } catch (error) {
    logger.error('Ошибка загрузки словарей:', error);
  }
}

/**
 * Загрузка словарей из IndexedDB в Trie (в память)
 * Для оптимизации загружаем только часто используемые слова
 */
async function loadDictionariesIntoTrie() {
  try {
    // Для производительности загружаем словари батчами
    // В реальной реализации можно использовать стратегию ленивой загрузки
    
    logger.log('Загрузка словарей в память (Trie)...');
    
    // Загружаем английский словарь
    const enWords = await loadWordsFromDB('english_words');
    dictManager.loadDictionary('en', enWords);
    
    // Загружаем русский словарь
    const ruWords = await loadWordsFromDB('russian_words');
    dictManager.loadDictionary('ru', ruWords);
    
    logger.log(`Словари загружены в память: en=${enWords.length}, ru=${ruWords.length}`);
    
    // Сохраняем статус в storage
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

/**
 * Загрузка всех слов из IndexedDB
 * @param {string} storeName - имя хранилища
 * @returns {Promise<string[]>}
 */
async function loadWordsFromDB(storeName) {
  return new Promise((resolve, reject) => {
    const words = [];
    const transaction = dictionaryDB.db.transaction([storeName], 'readonly');
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

/**
 * Обработка запросов от content script
 */
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
      return true; // Асинхронный ответ
    
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

/**
 * Обработка проверки слова
 * @param {string} word - слово для проверки
 * @returns {Promise<{isValid: boolean, lang: string|null}>}
 */
async function handleCheckWord(word) {
  if (!word || word.trim() === '') {
    return { isValid: true, lang: null };
  }
  
  const result = dictManager.checkWordAuto(word.trim());
  logger.log(`Проверка слова "${word}": ${result.isValid ? 'верно' : 'ошибка'} (${result.lang})`);
  
  return result;
}

/**
 * Обработка получения подсказок
 * @param {string} word - слово для подсказок
 * @returns {Promise<string[]>}
 */
async function handleGetSuggestions(word) {
  if (!word || word.trim() === '') {
    return [];
  }
  
  const suggestions = dictManager.getSuggestionsAuto(word.trim(), 10);
  logger.log(`Подсказки для "${word}": ${suggestions.length} найдено`);
  
  return suggestions;
}

/**
 * Обработка получения статуса
 * @returns {Promise<{loaded: boolean, enCount: number, ruCount: number}>}
 */
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

/**
 * Обработка перезагрузки словарей
 * @returns {Promise<{success: boolean}>}
 */
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

/**
 * Создание контекстного меню
 */
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

/**
 * Обработка клика по контекстному меню
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  logger.log('Клик по контекстному меню:', info.menuItemId);
  
  if (info.menuItemId === 'languagetool-ignore') {
    // Добавляем слово в исключения
    addWordToIgnore(info.selectionText);
  } else if (info.menuItemId.startsWith('languagetool-replace-')) {
    // Замена слова
    const replacement = info.menuItemId.replace('languagetool-replace-', '');
    replaceWordInTab(tab.id, info.selectionText, replacement);
  }
});

/**
 * Добавление слова в список исключений
 * @param {string} word - слово
 */
async function addWordToIgnore(word) {
  const storage = await chrome.storage.local.get(['ignoredWords']);
  const ignoredWords = storage.ignoredWords || [];
  
  if (!ignoredWords.includes(word.toLowerCase())) {
    ignoredWords.push(word.toLowerCase());
    await chrome.storage.local.set({ ignoredWords });
    logger.log(`Слово "${word}" добавлено в исключения`);
  }
}

/**
 * Замена слова в активной вкладке
 * @param {number} tabId - ID вкладки
 * @param {string} oldWord - старое слово
 * @param {string} newWord - новое слово
 */
function replaceWordInTab(tabId, oldWord, newWord) {
  chrome.tabs.sendMessage(tabId, {
    type: 'REPLACE_WORD',
    oldWord,
    newWord
  });
  
  logger.log(`Замена "${oldWord}" -> "${newWord}" во вкладке ${tabId}`);
}

// Инициализация при запуске
createContextMenu();
init();

// Перезагрузка при активации расширения
chrome.runtime.onInstalled.addListener(() => {
  logger.log('Расширение установлено/обновлено');
  init();
});
