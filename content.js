/**
 * @fileoverview Content Script для проверки орфографии в input полях
 * С ПОДРОБНЫМ ЛОГИРОВАНИЕМ для отладки
 */

// ============================================
// Logger для content script
// ============================================

const ContentLogger = (function() {
  const LEVELS = { DEBUG: 0, LOG: 1, INFO: 2, WARN: 3, ERROR: 4 };
  
  class Logger {
    constructor(context = 'content') {
      this.context = context;
      this.enabled = true;
      this.logLevel = LEVELS.DEBUG;
    }

    logToConsole(level, ...args) {
      const prefix = `[${this.context}]`;
      const consoleMethod = level.toLowerCase();
      if (console[consoleMethod]) {
        console[consoleMethod](prefix, ...args);
      } else {
        console.log(prefix, ...args);
      }
    }

    debug(...args) { this.logToConsole('DEBUG', ...args); }
    log(...args) { this.logToConsole('LOG', ...args); }
    info(...args) { this.logToConsole('INFO', ...args); }
    warn(...args) { this.logToConsole('WARN', ...args); }
    error(...args) { this.logToConsole('ERROR', ...args); }
  }
  
  return Logger;
})();

const logger = new ContentLogger('content');

// ============================================
// SpellChecker
// ============================================

class SpellChecker {
  constructor() {
    this.activeElement = null;
    this.checkDelay = 300;
    this.checkTimer = null;
    this.misspelledWords = new Map();
    this.isInitialized = false;
    this.ignoredWords = new Set();
    this.checkCount = 0;
    this.errorCount = 0;
    
    this.handleInput = this.handleInput.bind(this);
    this.handleFocus = this.handleFocus.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    
    this.loadIgnoredWords();
  }

  async init() {
    if (this.isInitialized) return;

    logger.log('=== ИНИЦИАЛИЗАЦИЯ CONTENT SCRIPT ===');
    logger.log('URL страницы:', window.location.href);
    logger.log('Document title:', document.title);
    
    await this.loadIgnoredWords();
    this.attachEventListeners();
    this.createTooltip();
    this.createReplacePopup();
    this.createDebugPanel();
    
    this.isInitialized = true;
    logger.log('✓ Content Script инициализирован');
    logger.log('Ожидание ввода текста в полях...');
  }

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

  attachEventListeners() {
    logger.log('Добавление слушателей событий...');
    
    document.addEventListener('focusin', this.handleFocus, true);
    document.addEventListener('focusout', this.handleBlur, true);
    document.addEventListener('input', this.handleInput, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    
    logger.log('✓ Слушатели добавлены');
  }

  handleFocus(event) {
    const target = event.target;
    
    if (this.isTextInput(target)) {
      this.activeElement = target;
      const elementType = target.tagName.toLowerCase();
      const inputType = target.type || 'text';
      
      logger.log('=== ФОКУС НА ПОЛЕ ===');
      logger.log(`Тип: ${elementType}${inputType !== 'text' ? ` type="${inputType}"` : ''}`);
      logger.log(`ID: ${target.id || 'нет'}`);
      logger.log(`Class: ${target.className || 'нет'}`);
      logger.log(`Текущее значение: "${target.value || target.textContent}"`);
      
      this.scheduleCheck(target.value || target.textContent || '');
    }
  }

  handleBlur(event) {
    if (this.activeElement === event.target) {
      logger.log('=== ПОТЕРЯ ФОКУСА ===');
      this.activeElement = null;
      this.clearCheckTimer();
    }
  }

  handleInput(event) {
    const target = event.target;
    
    if (this.isTextInput(target) && target === this.activeElement) {
      const value = target.value || target.textContent || '';
      logger.log(`ВВОД: "${value.slice(-50)}"${value.length > 50 ? '...' : ''}`);
      this.scheduleCheck(value);
    }
  }

  handleKeyDown(event) {
    if (event.key === 'Escape') {
      logger.log('ESC - скрытие tooltip/popup');
      this.hideTooltip();
      this.hideReplacePopup();
    }
  }

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

  scheduleCheck(text) {
    this.clearCheckTimer();
    
    this.checkTimer = setTimeout(() => {
      this.checkText(text);
    }, this.checkDelay);
  }

  clearCheckTimer() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  async checkText(text) {
    if (!text || !this.activeElement) return;

    this.checkCount++;
    const checkId = this.checkCount;
    
    logger.log(`=== ПРОВЕРКА #${checkId} ===`);
    
    const words = this.extractWords(text);
    logger.log(`Найдено слов: ${words.length}`);
    logger.log(`Слова: [${words.join(', ')}]`);
    
    const misspelled = [];
    
    for (const word of words) {
      if (this.ignoredWords.has(word.toLowerCase())) {
        logger.debug(`  Пропуск (исключение): "${word}"`);
        continue;
      }
      
      const result = await this.checkWord(word);
      
      if (!result.isValid) {
        misspelled.push({
          word,
          lang: result.lang,
          position: words.indexOf(word)
        });
        this.errorCount++;
        
        logger.log(`  ✗ ОШИБКА: "${word}" (язык: ${result || 'unknown'})`);
      } else {
        logger.debug(`  ✓ Верно: "${word}"`);
      }
    }
    
    this.misspelledWords = new Map(
      misspelled.map(m => [m.word, m])
    );

    if (misspelled.length > 0) {
      logger.warn(`Найдено ошибок: ${misspelled.length}`);
      logger.warn(`Ошибочные слова: [${misspelled.map(m => m.word).join(', ')}]`);

      if (this.activeElement && this.activeElement.tagName?.toLowerCase() === 'textarea') {
        this.highlightErrors(text, misspelled);
      }
    } else {
      logger.log('✓ Ошибок не найдено');
    }

    // Обновляем debug панель
    this.updateDebugPanel();
  }

  extractWords(text) {
    return text
      .split(/[\s,.;:!?()"'`\-–—]+/)
      .filter(w => w.trim().length > 0);
  }

  checkWord(word) {
    return new Promise((resolve) => {
      // Проверяем, доступен ли runtime перед отправкой
      if (!chrome.runtime?.id) {
        logger.debug(`  Проверка "${word}": runtime недоступен`);
        resolve({ isValid: true, lang: null });
        return;
      }

      // Используем setTimeout для безопасного выполнения
      setTimeout(() => {
        try {
          chrome.runtime.sendMessage(
            { type: 'CHECK_WORD', word },
            (response) => {
              // Проверяем наличие ошибки после получения ответа
              const lastError = chrome.runtime?.lastError;
              if (lastError) {
                logger.debug(`  Проверка "${word}": ${lastError.message}`);
                resolve({ isValid: true, lang: null });
                return;
              }
              
              logger.debug(`  Проверка "${word}":`, response);
              resolve(response);
            }
          );
        } catch (error) {
          // Ловим ошибки отправки сообщения
          logger.debug(`  Проверка "${word}": ошибка отправки (${error.message})`);
          resolve({ isValid: true, lang: null });
        }
      }, 0);
    });
  }

  getSuggestions(word) {
    return new Promise((resolve) => {
      // Проверяем, доступен ли runtime перед отправкой
      if (!chrome.runtime?.id) {
        logger.debug(`  Подсказки для "${word}": runtime недоступен`);
        resolve([]);
        return;
      }

      // Используем setTimeout для безопасного выполнения
      setTimeout(() => {
        try {
          chrome.runtime.sendMessage(
            { type: 'GET_SUGGESTIONS', word, limit: 15 },
            (response) => {
              // Проверяем наличие ошибки после получения ответа
              const lastError = chrome.runtime?.lastError;
              if (lastError) {
                logger.debug(`  Подсказки для "${word}": ${lastError.message}`);
                resolve([]);
                return;
              }
              
              logger.log(`  Подсказки для "${word}": найдено ${response?.length || 0}`);
              if (response && response.length > 0) {
                logger.log(`  Варианты: [${response.join(', ')}]`);
              }
              resolve(response);
            }
          );
        } catch (error) {
          // Ловим ошибки отправки сообщения
          logger.debug(`  Подсказки для "${word}": ошибка отправки (${error.message})`);
          resolve([]);
        }
      }, 0);
    });
  }

  highlightErrors(text, misspelled) {
    if (!this.activeElement) {
      logger.warn('highlightErrors: нет активного элемента');
      return;
    }

    let overlay = this.activeElement.parentElement?.querySelector('.spell-check-overlay');

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'spell-check-overlay';
      this.activeElement.parentElement?.insertBefore(overlay, this.activeElement);
    }

    this.syncOverlayStyles(this.activeElement, overlay);
    this.renderErrors(overlay, text, misspelled);
  }

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

  renderErrors(overlay, text, misspelled) {
    let html = text;

    const sortedMisspelled = [...misspelled].sort((a, b) => b.word.length - a.word.length);

    for (const error of sortedMisspelled) {
      const regex = new RegExp(`\\b${this.escapeRegex(error.word)}\\b`, 'gi');
      html = html.replace(
        regex,
        `<span class="spell-error" data-word="${error.word}" tabindex="0">${error.word}</span>`
      );
    }

    overlay.innerHTML = html;

    // Добавляем обработчики для ошибочных слов
    overlay.querySelectorAll('.spell-error').forEach(el => {
      // Клик - замена слова
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const word = el.dataset.word;
        const rect = el.getBoundingClientRect();
        logger.log(`Клик на ошибочном слове: "${word}"`);
        this.showTooltip(word, rect.left, rect.bottom + 5);
      });
      
      // Hover - показ tooltip с кандидатами
      el.addEventListener('mouseenter', (e) => {
        const word = el.dataset.word;
        const rect = el.getBoundingClientRect();
        this.showTooltipOnHover(word, rect.left, rect.bottom + 5);
      });
      
      el.addEventListener('mouseleave', () => {
        this.hideTooltipOnHover();
      });
      
      // Фокус для клавиатуры
      el.addEventListener('focus', (e) => {
        const word = el.dataset.word;
        const rect = el.getBoundingClientRect();
        this.showTooltipOnHover(word, rect.left, rect.bottom + 5);
      });
      
      el.addEventListener('blur', () => {
        this.hideTooltipOnHover();
      });
    });

    logger.log(`Добавлены обработчики на ${misspelled.length} ошибок`);
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  createTooltip() {
    if (document.getElementById('spell-check-tooltip')) return;

    const tooltip = document.createElement('div');
    tooltip.id = 'spell-check-tooltip';
    tooltip.className = 'spell-check-tooltip';
    tooltip.style.display = 'none';
    
    document.body.appendChild(tooltip);
    tooltip.addEventListener('click', this.handleTooltipClick.bind(this));
  }

  // Таймер для hover tooltip
  hoverTooltipTimer = null;
  hoverTooltipDelay = 300; // 300ms задержка перед показом

  async showTooltip(word, x, y) {
    const tooltip = document.getElementById('spell-check-tooltip');
    if (!tooltip) return;

    logger.log('=== ПОКАЗ TOOLTIP ===');
    logger.log(`Слово: "${word}"`);
    logger.log(`Позиция: (${x}, ${y})`);

    const suggestions = await this.getSuggestions(word);

    if (suggestions.length === 0) {
      tooltip.innerHTML = '<div class="no-suggestions">Нет предложений</div>';
      logger.warn('Нет предложений для замены');
    } else {
      const suggestionsHtml = suggestions
        .map(s => `<div class="suggestion-item" data-word="${this.escapeAttr(s)}">${s}</div>`)
        .join('');

      tooltip.innerHTML = `
        <div class="tooltip-header">Заменить на:</div>
        <div class="suggestions-list">${suggestionsHtml}</div>
      `;

      logger.log(`Показано ${suggestions.length} вариантов замены`);
    }

    tooltip.style.display = 'block';
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';

    this.adjustTooltipPosition(tooltip);
  }

  async showTooltipOnHover(word, x, y) {
    // Очищаем предыдущий таймер
    if (this.hoverTooltipTimer) {
      clearTimeout(this.hoverTooltipTimer);
    }

    // Показываем tooltip с задержкой
    this.hoverTooltipTimer = setTimeout(async () => {
      const tooltip = document.getElementById('spell-check-tooltip');
      if (!tooltip) return;

      // Получаем подсказки
      const suggestions = await this.getSuggestions(word);

      if (suggestions.length === 0) {
        tooltip.innerHTML = `
          <div class="tooltip-header-hover">
            <strong>${word}</strong> — нет в словаре
          </div>
          <div class="no-suggestions">Нет предложений для замены</div>
        `;
      } else {
        const suggestionsHtml = suggestions
          .slice(0, 8) // Показываем максимум 8 кандидатов
          .map(s => `<div class="suggestion-item-hover" data-word="${this.escapeAttr(s)}">${s}</div>`)
          .join('');

        tooltip.innerHTML = `
          <div class="tooltip-header-hover">
            <strong>${word}</strong> — ошибка
          </div>
          <div class="suggestions-list-hover">
            <div class="suggestion-label">Возможные замены:</div>
            ${suggestionsHtml}
          </div>
          <div class="tooltip-footer-hover">
            Кликните для замены
          </div>
        `;

        // Добавляем обработчики на элементы списка
        tooltip.querySelectorAll('.suggestion-item-hover').forEach(el => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const replacement = el.dataset.word;
            logger.log(`Выбрана замена: "${replacement}"`);
            this.replaceWord(replacement);
            this.hideTooltip();
          });
        });
      }

      tooltip.style.display = 'block';
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.classList.add('tooltip-hover');

      this.adjustTooltipPosition(tooltip);
    }, this.hoverTooltipDelay);
  }

  hideTooltipOnHover() {
    if (this.hoverTooltipTimer) {
      clearTimeout(this.hoverTooltipTimer);
      this.hoverTooltipTimer = null;
    }
    this.hideTooltip();
  }

  escapeAttr(string) {
    return string
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

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

  hideTooltip() {
    const tooltip = document.getElementById('spell-check-tooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }

  handleTooltipClick(event) {
    const suggestionItem = event.target.closest('.suggestion-item');
    
    if (suggestionItem) {
      const replacement = suggestionItem.dataset.word;
      logger.log('=== ЗАМЕНА СЛОВА (tooltip) ===');
      logger.log(`Текущее: "${Array.from(this.misspelledWords.keys())[0]}"`);
      logger.log(`Замена на: "${replacement}"`);
      
      this.replaceWord(replacement);
      this.hideTooltip();
    }
  }

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

  async showReplacePopup(word) {
    const popup = document.getElementById('spell-check-popup');
    if (!popup) return;
    
    logger.log('=== ПОКАЗ POPUP ===');
    logger.log(`Слово: "${word}"`);
    
    document.getElementById('popup-current-word').textContent = word;
    
    const suggestions = await this.getSuggestions(word);
    const suggestionsContainer = document.getElementById('popup-suggestions');
    
    if (suggestions.length === 0) {
      suggestionsContainer.innerHTML = '<div class="no-suggestions">Нет предложений</div>';
      logger.warn('Нет предложений для замены');
    } else {
      suggestionsContainer.innerHTML = suggestions
        .map(s => `<button class="suggestion-btn" data-word="${this.escapeAttr(s)}">${s}</button>`)
        .join('');
      
      logger.log(`Показано ${suggestions.length} вариантов замены`);
    }
    
    popup.style.display = 'flex';
    this.centerPopup(popup);
  }

  centerPopup(popup) {
    const rect = popup.querySelector('.popup-content').getBoundingClientRect();
    popup.style.left = ((window.innerWidth - rect.width) / 2) + 'px';
    popup.style.top = ((window.innerHeight - rect.height) / 2) + 'px';
  }

  hideReplacePopup() {
    const popup = document.getElementById('spell-check-popup');
    if (popup) popup.style.display = 'none';
  }

  handlePopupClick(event) {
    if (event.target === document.getElementById('spell-check-popup')) {
      this.hideReplacePopup();
      return;
    }
    
    const suggestionBtn = event.target.closest('.suggestion-btn');
    if (suggestionBtn) {
      const replacement = suggestionBtn.dataset.word;
      logger.log('=== ЗАМЕНА СЛОВА (popup) ===');
      logger.log(`Текущее: "${Array.from(this.misspelledWords.keys())[0]}"`);
      logger.log(`Замена на: "${replacement}"`);
      
      this.replaceWord(replacement);
      this.hideReplacePopup();
    }
  }

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
    
    logger.log('=== ЗАМЕНА ВЫПОЛНЕНА ===');
    logger.log(`Было: "${text}"`);
    logger.log(`Стало: "${newText}"`);
    
    if (this.activeElement.tagName.toLowerCase() === 'textarea') {
      this.activeElement.value = newText;
    } else {
      this.activeElement.textContent = newText;
    }
    
    this.misspelledWords.delete(misspelledWord);
    
    const overlay = this.activeElement.parentElement?.querySelector('.spell-check-overlay');
    if (overlay) overlay.remove();
    
    this.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    
    this.updateDebugPanel();
  }

  handleMessage(message) {
    logger.log('← Сообщение от background:', message.type);
    
    switch (message.type) {
      case 'REPLACE_WORD':
        this.handleReplaceWordMessage(message.oldWord, message.newWord);
        break;
    }
  }

  handleReplaceWordMessage(oldWord, newWord) {
    if (!this.activeElement) return;
    
    const text = this.activeElement.value || this.activeElement.textContent;
    const newText = text.replace(
      new RegExp(`\\b${this.escapeRegex(oldWord)}\\b`, 'gi'),
      newWord
    );
    
    logger.log('=== ЗАМЕНА (контекстное меню) ===');
    logger.log(`"${oldWord}" → "${newWord}"`);
    
    if (this.activeElement.tagName.toLowerCase() === 'textarea') {
      this.activeElement.value = newText;
    } else {
      this.activeElement.textContent = newText;
    }
    
    this.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    this.updateDebugPanel();
  }

  // ============================================
  // Debug Panel для отображения статистики
  // ============================================

  createDebugPanel() {
    if (document.getElementById('spell-debug-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'spell-debug-panel';
    panel.innerHTML = `
      <div class="debug-header">
        <span>🔍 LanguageTool Debug</span>
        <button class="debug-toggle">▼</button>
      </div>
      <div class="debug-content">
        <div class="debug-stat">
          <span class="label">Проверок:</span>
          <span class="value" id="debug-checks">0</span>
        </div>
        <div class="debug-stat">
          <span class="label">Ошибок найдено:</span>
          <span class="value error" id="debug-errors">0</span>
        </div>
        <div class="debug-stat">
          <span class="label">Активное поле:</span>
          <span class="value" id="debug-field">-</span>
        </div>
        <div class="debug-log" id="debug-log"></div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    // Стили
    panel.style.cssText = `
      position: fixed;
      bottom: 10px;
      right: 10px;
      width: 350px;
      max-height: 400px;
      background: #1a1a2e;
      color: #eee;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 100000;
      overflow: hidden;
    `;
    
    panel.querySelector('.debug-toggle').addEventListener('click', () => {
      const content = panel.querySelector('.debug-content');
      const btn = panel.querySelector('.debug-toggle');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        btn.textContent = '▼';
      } else {
        content.style.display = 'none';
        btn.textContent = '▲';
      }
    });
    
    logger.log('Debug панель создана');
  }

  updateDebugPanel() {
    const checksEl = document.getElementById('debug-checks');
    const errorsEl = document.getElementById('debug-errors');
    const fieldEl = document.getElementById('debug-field');
    
    if (checksEl) checksEl.textContent = this.checkCount;
    if (errorsEl) errorsEl.textContent = this.errorCount;
    
    if (fieldEl) {
      if (this.activeElement) {
        const tag = this.activeElement.tagName.toLowerCase();
        const id = this.activeElement.id || '';
        const type = this.activeElement.type || '';
        fieldEl.textContent = `${tag}${id ? '#' + id : ''}${type ? `[${type}]` : ''}`;
      } else {
        fieldEl.textContent = '-';
      }
    }
  }
}

// Глобальный экземпляр
const spellChecker = new SpellChecker();

logger.log('=== CONTENT SCRIPT ЗАГРУЖЕН ===');
logger.log('URL:', window.location.href);
logger.log('Title:', document.title);

// Инициализация
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    logger.log('DOM загружен, инициализация...');
    spellChecker.init();
  });
} else {
  logger.log('DOM уже загружен, инициализация...');
  spellChecker.init();
}

// Экспорт для отладки
window.spellChecker = spellChecker;
