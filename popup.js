/**
 * @fileoverview Скрипт для popup страницы расширения
 * Управляет отображением статуса, статистики и действий
 */

import { Logger } from './logger.js';

const logger = new Logger('popup');

class PopupManager {
  constructor() {
    this.elements = {};
    this.init();
  }

  /**
   * Инициализация
   */
  async init() {
    logger.log('Инициализация popup...');
    
    // Кэшируем элементы DOM
    this.cacheElements();
    
    // Добавляем обработчики событий
    this.attachEventListeners();
    
    // Обновляем статус
    await this.updateStatus();
    
    // Обновляем список исключений
    await this.updateIgnoreList();
    
    logger.log('Popup инициализирован');
  }

  /**
   * Кэширование элементов DOM
   */
  cacheElements() {
    this.elements = {
      // Статус
      statusCard: document.getElementById('status-card'),
      statusIndicator: document.getElementById('status-indicator'),
      statusText: document.getElementById('status-text'),
      statusDetail: document.getElementById('status-detail'),
      
      // Статистика
      enCount: document.getElementById('en-count'),
      ruCount: document.getElementById('ru-count'),
      totalCount: document.getElementById('total-count'),
      
      // Кнопки
      reloadBtn: document.getElementById('reload-btn'),
      exportLogsBtn: document.getElementById('export-logs-btn'),
      clearLogsBtn: document.getElementById('clear-logs-btn'),
      clearIgnoreBtn: document.getElementById('clear-ignore-btn'),
      
      // Список исключений
      ignoreList: document.getElementById('ignore-list')
    };
  }

  /**
   * Добавление обработчиков событий
   */
  attachEventListeners() {
    this.elements.reloadBtn.addEventListener('click', () => this.handleReload());
    this.elements.exportLogsBtn.addEventListener('click', () => this.handleExportLogs());
    this.elements.clearLogsBtn.addEventListener('click', () => this.handleClearLogs());
    this.elements.clearIgnoreBtn.addEventListener('click', () => this.handleClearIgnore());
  }

  /**
   * Обновление статуса словарей
   */
  async updateStatus() {
    try {
      // Получаем статус из background
      const status = await this.sendMessage({ type: 'GET_STATUS' });
      
      if (status.loaded) {
        this.setReadyStatus(status);
      } else {
        this.setLoadingStatus();
      }
    } catch (error) {
      logger.error('Ошибка получения статуса:', error);
      this.setErrorStatus();
    }
  }

  /**
   * Установка статуса "Готово"
   * @param {Object} status
   */
  setReadyStatus(status) {
    this.elements.statusIndicator.className = 'status-indicator ready';
    this.elements.statusText.textContent = 'Словари загружены';
    this.elements.statusDetail.textContent = `${status.total.toLocaleString()} слов`;
    
    // Обновляем статистику
    this.elements.enCount.textContent = (status.enCount || 0).toLocaleString();
    this.elements.ruCount.textContent = (status.ruCount || 0).toLocaleString();
    this.elements.totalCount.textContent = (status.total || 0).toLocaleString();
  }

  /**
   * Установка статуса "Загрузка"
   */
  setLoadingStatus() {
    this.elements.statusIndicator.className = 'status-indicator loading';
    this.elements.statusText.textContent = 'Загрузка словарей...';
    this.elements.statusDetail.textContent = 'Пожалуйста, подождите';
    
    this.elements.enCount.textContent = '...';
    this.elements.ruCount.textContent = '...';
    this.elements.totalCount.textContent = '...';
  }

  /**
   * Установка статуса "Ошибка"
   */
  setErrorStatus() {
    this.elements.statusIndicator.className = 'status-indicator error';
    this.elements.statusText.textContent = 'Ошибка загрузки';
    this.elements.statusDetail.textContent = 'Проверьте консоль для деталей';
    
    this.elements.enCount.textContent = '0';
    this.elements.ruCount.textContent = '0';
    this.elements.totalCount.textContent = '0';
  }

  /**
   * Обновление списка исключений
   */
  async updateIgnoreList() {
    try {
      const storage = await chrome.storage.local.get(['ignoredWords']);
      const ignoredWords = storage.ignoredWords || [];
      
      if (ignoredWords.length === 0) {
        this.elements.ignoreList.innerHTML = '<p class="ignore-empty">Нет игнорируемых слов</p>';
      } else {
        this.elements.ignoreList.innerHTML = ignoredWords
          .map(word => `
            <span class="ignore-word">
              ${this.escapeHtml(word)}
              <button data-word="${this.escapeAttr(word)}" title="Удалить">&times;</button>
            </span>
          `)
          .join('');
        
        // Добавляем обработчики для кнопок удаления
        this.elements.ignoreList.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('click', () => this.handleRemoveIgnore(btn.dataset.word));
        });
      }
    } catch (error) {
      logger.error('Ошибка обновления списка исключений:', error);
    }
  }

  /**
   * Обработка перезагрузки словарей
   */
  async handleReload() {
    logger.log('Перезагрузка словарей...');
    
    this.setLoadingStatus();
    this.elements.reloadBtn.disabled = true;
    
    try {
      const result = await this.sendMessage({ type: 'RELOAD_DICTIONARIES' });
      
      if (result.success) {
        await this.updateStatus();
        this.showToast('Словари перезапущены', 'success');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      logger.error('Ошибка перезагрузки:', error);
      this.setErrorStatus();
      this.showToast('Ошибка перезагрузки: ' + error.message, 'error');
    } finally {
      this.elements.reloadBtn.disabled = false;
    }
  }

  /**
   * Обработка экспорта логов
   */
  async handleExportLogs() {
    try {
      const storage = await chrome.storage.local.get(['logs']);
      const logs = storage.logs || [];
      
      if (logs.length === 0) {
        this.showToast('Нет логов для экспорта', 'error');
        return;
      }
      
      const json = JSON.stringify(logs, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `languagetool-logs-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      
      URL.revokeObjectURL(url);
      
      this.showToast(`Экспортировано ${logs.length} записей`, 'success');
    } catch (error) {
      logger.error('Ошибка экспорта логов:', error);
      this.showToast('Ошибка экспорта', 'error');
    }
  }

  /**
   * Обработка очистки логов
   */
  async handleClearLogs() {
    try {
      await chrome.storage.local.set({ logs: [] });
      this.showToast('Логи очищены', 'success');
    } catch (error) {
      logger.error('Ошибка очистки логов:', error);
      this.showToast('Ошибка очистки', 'error');
    }
  }

  /**
   * Обработка очистки списка исключений
   */
  async handleClearIgnore() {
    try {
      await chrome.storage.local.set({ ignoredWords: [] });
      await this.updateIgnoreList();
      this.showToast('Список исключений очищен', 'success');
    } catch (error) {
      logger.error('Ошибка очистки исключений:', error);
      this.showToast('Ошибка очистки', 'error');
    }
  }

  /**
   * Обработка удаления слова из исключений
   * @param {string} word
   */
  async handleRemoveIgnore(word) {
    try {
      const storage = await chrome.storage.local.get(['ignoredWords']);
      const ignoredWords = storage.ignoredWords || [];
      
      const index = ignoredWords.indexOf(word.toLowerCase());
      if (index > -1) {
        ignoredWords.splice(index, 1);
        await chrome.storage.local.set({ ignoredWords });
        await this.updateIgnoreList();
        this.showToast(`Слово "${word}" удалено из исключений`, 'success');
      }
    } catch (error) {
      logger.error('Ошибка удаления исключения:', error);
      this.showToast('Ошибка удаления', 'error');
    }
  }

  /**
   * Отправка сообщения в background script
   * @param {Object} message
   * @returns {Promise<any>}
   */
  sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Показ уведомления
   * @param {string} message
   * @param {string} type
   */
  showToast(message, type = 'info') {
    // Удаляем существующие toast
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
      existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // Анимация появления
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Удаление через 3 секунды
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  /**
   * Экранирование HTML
   * @param {string} string
   * @returns {string}
   */
  escapeHtml(string) {
    return string
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Экранирование атрибутов
   * @param {string} string
   * @returns {string}
   */
  escapeAttr(string) {
    return string
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// Инициализация popup
new PopupManager();
