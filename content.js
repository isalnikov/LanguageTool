/**
 * @fileoverview Content Script для проверки орфографии в input полях
 * Работает со всеми текстовыми полями на странице
 */

// Используем глобальный объект LanguageTool
const { Logger } = window.LanguageTool;

const logger = new Logger('content');

// Класс для управления проверкой орфографии
class SpellChecker {
  constructor() {
    this.activeElement = null;
    this.checkDelay = 300;
    this.checkTimer = null;
    this.misspelledWords = new Map();
    this.isInitialized = false;
    this.ignoredWords = new Set();
    
    this.handleInput = this.handleInput.bind(this);
    this.handleFocus = this.handleFocus.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    
    this.loadIgnoredWords();
  }

  /**
   * Инициализация
   */
  async init() {
    if (this.isInitialized) return;

    logger.log('Инициализация Content Script...');
    
    await this.loadIgnoredWords();
    this.attachEventListeners();
    this.createTooltip();
    this.createReplacePopup();
    
    this.isInitialized = true;
    logger.log('Content Script инициализирован');
  }

  /**
   * Загрузка слов-исключений из storage
   */
  async loadIgnoredWords() {
    try {
      const storage = await chrome.storage.local.get(['ignoredWords']);
      const ignoredWords = storage.ignoredWords || [];
      this.ignoredWords = new Set(ignoredWords);
      logger.log(`Загружено ${this.ignoredWords.size} слов-исключений`);
    } catch (error) {
      logger.error('Ошибка загрузки исключений:', error);
    }
  }

  /**
   * Добавление слушателей событий
   */
  attachEventListeners() {
    document.addEventListener('focusin', this.handleFocus, true);
    document.addEventListener('focusout', this.handleBlur, true);
    document.addEventListener('input', this.handleInput, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    
    logger.log('Слушатели событий добавлены');
  }

  /**
   * Обработка фокуса на элементе
   */
  handleFocus(event) {
    const target = event.target;
    
    if (this.isTextInput(target)) {
      this.activeElement = target;
      logger.log('Фокус на текстовом поле:', target.tagName);
      this.scheduleCheck(target.value);
    }
  }

  /**
   * Обработка потери фокуса
   */
  handleBlur(event) {
    if (this.activeElement === event.target) {
      this.activeElement = null;
      this.clearCheckTimer();
    }
  }

  /**
   * Обработка ввода текста
   */
  handleInput(event) {
    const target = event.target;
    
    if (this.isTextInput(target) && target === this.activeElement) {
      this.scheduleCheck(target.value);
    }
  }

  /**
   * Обработка нажатий клавиш
   */
  handleKeyDown(event) {
    if (event.key === 'Escape') {
      this.hideTooltip();
      this.hideReplacePopup();
    }
  }

  /**
   * Проверка, является ли элемент текстовым полем
   */
  isTextInput(element) {
    if (!element) return false;
    
    const tagName = element.tagName.toLowerCase();
    const type = element.type?.toLowerCase();
    
    if (tagName === 'input') {
      const textTypes = ['text', 'search', 'email', 'url', 'password', 'tel'];
      return textTypes.includes(type) || !type;
    }
    
    if (tagName === 'textarea') return true;
    if (element.isContentEditable) return true;
    
    return false;
  }

  /**
   * Планирование проверки текста
   */
  scheduleCheck(text) {
    this.clearCheckTimer();
    
    this.checkTimer = setTimeout(() => {
      this.checkText(text);
    }, this.checkDelay);
  }

  /**
   * Очистка таймера проверки
   */
  clearCheckTimer() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Проверка текста на орфографические ошибки
   */
  async checkText(text) {
    if (!text || !this.activeElement) return;

    logger.log('Проверка текста...');
    
    const words = this.extractWords(text);
    const misspelled = [];
    
    for (const word of words) {
      if (this.ignoredWords.has(word.toLowerCase())) continue;
      
      const result = await this.checkWord(word);
      if (!result.isValid) {
        misspelled.push({
          word,
          lang: result.lang,
          position: words.indexOf(word)
        });
      }
    }
    
    this.misspelledWords = new Map(
      misspelled.map(m => [m.word, m])
    );
    
    if (this.activeElement.tagName.toLowerCase() === 'textarea') {
      this.highlightErrors(text, misspelled);
    }
    
    logger.log(`Найдено ошибок: ${misspelled.length}`);
  }

  /**
   * Извлечение слов из текста
   */
  extractWords(text) {
    return text
      .split(/[\s,.;:!?()"'`\-–—]+/)
      .filter(w => w.trim().length > 0);
  }

  /**
   * Проверка одного слова через background script
   */
  checkWord(word) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'CHECK_WORD', word },
        (response) => {
          if (chrome.runtime.lastError) {
            logger.error('Ошибка проверки слова:', chrome.runtime.lastError);
            resolve({ isValid: true, lang: null });
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /**
   * Получение подсказок для слова
   */
  getSuggestions(word) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'GET_SUGGESTIONS', word },
        (response) => {
          if (chrome.runtime.lastError) {
            logger.error('Ошибка получения подсказок:', chrome.runtime.lastError);
            resolve([]);
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /**
   * Подсветка ошибок в textarea
   */
  highlightErrors(text, misspelled) {
    let overlay = this.activeElement.parentElement?.querySelector('.spell-check-overlay');
    
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'spell-check-overlay';
      this.activeElement.parentElement?.insertBefore(overlay, this.activeElement);
    }
    
    this.syncOverlayStyles(this.activeElement, overlay);
    this.renderErrors(overlay, text, misspelled);
  }

  /**
   * Синхронизация стилей overlay с textarea
   */
  syncOverlayStyles(textarea, overlay) {
    const styles = window.getComputedStyle(textarea);
    
    overlay.style.position = 'absolute';
    overlay.style.top = textarea.offsetTop + 'px';
    overlay.style.left = textarea.offsetLeft + 'px';
    overlay.style.width = textarea.offsetWidth + 'px';
    overlay.style.height = textarea.offsetHeight + 'px';
    overlay.style.padding = styles.padding;
    overlay.style.fontSize = styles.fontSize;
    overlay.style.fontFamily = styles.fontFamily;
    overlay.style.lineHeight = styles.lineHeight;
    overlay.style.whiteSpace = 'pre-wrap';
    overlay.style.wordWrap = 'break-word';
    overlay.style.pointerEvents = 'none';
    overlay.style.overflow = 'hidden';
  }

  /**
   * Рендеринг ошибок на overlay
   */
  renderErrors(overlay, text, misspelled) {
    let html = text;
    
    const sortedMisspelled = [...misspelled].sort((a, b) => b.word.length - a.word.length);
    
    for (const error of sortedMisspelled) {
      const regex = new RegExp(`\\b${this.escapeRegex(error.word)}\\b`, 'gi');
      html = html.replace(
        regex,
        `<span class="spell-error" data-word="${error.word}">${error.word}</span>`
      );
    }
    
    overlay.innerHTML = html;
  }

  /**
   * Экранирование спецсимволов для regex
   */
  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Создание tooltip
   */
  createTooltip() {
    if (document.getElementById('spell-check-tooltip')) return;

    const tooltip = document.createElement('div');
    tooltip.id = 'spell-check-tooltip';
    tooltip.className = 'spell-check-tooltip';
    tooltip.style.display = 'none';
    
    document.body.appendChild(tooltip);
    tooltip.addEventListener('click', this.handleTooltipClick.bind(this));
  }

  /**
   * Показ tooltip с подсказками
   */
  async showTooltip(word, x, y) {
    const tooltip = document.getElementById('spell-check-tooltip');
    if (!tooltip) return;
    
    logger.log('Показ tooltip для слова:', word);
    
    const suggestions = await this.getSuggestions(word);
    
    if (suggestions.length === 0) {
      tooltip.innerHTML = '<div class="no-suggestions">Нет предложений</div>';
    } else {
      const suggestionsHtml = suggestions
        .map(s => `<div class="suggestion-item" data-word="${this.escapeAttr(s)}">${s}</div>`)
        .join('');
      
      tooltip.innerHTML = `
        <div class="tooltip-header">Заменить на:</div>
        <div class="suggestions-list">${suggestionsHtml}</div>
      `;
    }
    
    tooltip.style.display = 'block';
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    
    this.adjustTooltipPosition(tooltip);
  }

  /**
   * Экранирование атрибутов HTML
   */
  escapeAttr(string) {
    return string
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Корректировка позиции tooltip
   */
  adjustTooltipPosition(tooltip) {
    const rect = tooltip.getBoundingClientRect();
    const padding = 10;
    
    if (rect.right > window.innerWidth - padding) {
      tooltip.style.left = (window.innerWidth - rect.width - padding) + 'px';
    }
    
    if (rect.bottom > window.innerHeight - padding) {
      tooltip.style.top = (window.innerHeight - rect.height - padding) + 'px';
    }
    
    if (rect.left < padding) {
      tooltip.style.left = padding + 'px';
    }
    
    if (rect.top < padding) {
      tooltip.style.top = padding + 'px';
    }
  }

  /**
   * Скрытие tooltip
   */
  hideTooltip() {
    const tooltip = document.getElementById('spell-check-tooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  /**
   * Обработка клика по tooltip
   */
  handleTooltipClick(event) {
    const suggestionItem = event.target.closest('.suggestion-item');
    
    if (suggestionItem) {
      const replacement = suggestionItem.dataset.word;
      this.replaceWord(replacement);
      this.hideTooltip();
      logger.log('Замена слова на:', replacement);
    }
  }

  /**
   * Создание popup для замены слов
   */
  createReplacePopup() {
    if (document.getElementById('spell-check-popup')) return;

    const popup = document.createElement('div');
    popup.id = 'spell-check-popup';
    popup.className = 'spell-check-popup';
    popup.style.display = 'none';
    popup.innerHTML = `
      <div class="popup-content">
        <div class="popup-header">
          <span class="popup-title">Замена слова</span>
          <button class="popup-close">&times;</button>
        </div>
        <div class="popup-body">
          <div class="current-word">
            <span class="label">Текущее:</span>
            <span class="word-value" id="popup-current-word"></span>
          </div>
          <div class="suggestions-container">
            <div class="label">Предложения:</div>
            <div class="suggestions-grid" id="popup-suggestions"></div>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(popup);
    popup.querySelector('.popup-close').addEventListener('click', () => this.hideReplacePopup());
    popup.addEventListener('click', this.handlePopupClick.bind(this));
  }

  /**
   * Показ popup для замены
   */
  async showReplacePopup(word) {
    const popup = document.getElementById('spell-check-popup');
    if (!popup) return;
    
    logger.log('Показ popup для слова:', word);
    
    document.getElementById('popup-current-word').textContent = word;
    
    const suggestions = await this.getSuggestions(word);
    const suggestionsContainer = document.getElementById('popup-suggestions');
    
    if (suggestions.length === 0) {
      suggestionsContainer.innerHTML = '<div class="no-suggestions">Нет предложений</div>';
    } else {
      suggestionsContainer.innerHTML = suggestions
        .map(s => `<button class="suggestion-btn" data-word="${this.escapeAttr(s)}">${s}</button>`)
        .join('');
    }
    
    popup.style.display = 'flex';
    this.centerPopup(popup);
  }

  /**
   * Центрирование popup
   */
  centerPopup(popup) {
    const rect = popup.querySelector('.popup-content').getBoundingClientRect();
    popup.style.left = ((window.innerWidth - rect.width) / 2) + 'px';
    popup.style.top = ((window.innerHeight - rect.height) / 2) + 'px';
  }

  /**
   * Скрытие popup
   */
  hideReplacePopup() {
    const popup = document.getElementById('spell-check-popup');
    if (popup) popup.style.display = 'none';
  }

  /**
   * Обработка клика по popup
   */
  handlePopupClick(event) {
    if (event.target === document.getElementById('spell-check-popup')) {
      this.hideReplacePopup();
      return;
    }
    
    const suggestionBtn = event.target.closest('.suggestion-btn');
    if (suggestionBtn) {
      const replacement = suggestionBtn.dataset.word;
      this.replaceWord(replacement);
      this.hideReplacePopup();
      logger.log('Замена слова на:', replacement);
    }
  }

  /**
   * Замена слова в активном элементе
   */
  replaceWord(replacement) {
    if (!this.activeElement) {
      logger.warn('Нет активного элемента для замены');
      return;
    }
    
    const text = this.activeElement.value || this.activeElement.textContent;
    const misspelledWord = Array.from(this.misspelledWords.keys())[0];
    
    if (!misspelledWord) {
      logger.warn('Не найдено слово для замены');
      return;
    }
    
    const newText = text.replace(
      new RegExp(`\\b${this.escapeRegex(misspelledWord)}\\b`),
      replacement
    );
    
    if (this.activeElement.tagName.toLowerCase() === 'textarea') {
      this.activeElement.value = newText;
    } else {
      this.activeElement.textContent = newText;
    }
    
    this.misspelledWords.delete(misspelledWord);
    
    const overlay = this.activeElement.parentElement?.querySelector('.spell-check-overlay');
    if (overlay) overlay.remove();
    
    this.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    
    logger.log(`Слово "${misspelledWord}" заменено на "${replacement}"`);
  }

  /**
   * Обработка сообщений
   */
  handleMessage(message) {
    logger.log('Получено сообщение:', message.type);
    
    switch (message.type) {
      case 'REPLACE_WORD':
        this.handleReplaceWordMessage(message.oldWord, message.newWord);
        break;
    }
  }

  /**
   * Обработка сообщения замены слова
   */
  handleReplaceWordMessage(oldWord, newWord) {
    if (!this.activeElement) return;
    
    const text = this.activeElement.value || this.activeElement.textContent;
    const newText = text.replace(
      new RegExp(`\\b${this.escapeRegex(oldWord)}\\b`, 'gi'),
      newWord
    );
    
    if (this.activeElement.tagName.toLowerCase() === 'textarea') {
      this.activeElement.value = newText;
    } else {
      this.activeElement.textContent = newText;
    }
    
    this.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    logger.log(`Замена через контекстное меню: "${oldWord}" -> "${newWord}"`);
  }
}

// Глобальный экземпляр
const spellChecker = new SpellChecker();

// Инициализация после загрузки DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => spellChecker.init());
} else {
  spellChecker.init();
}

// Экспорт для отладки
window.spellChecker = spellChecker;
