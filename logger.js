/**
 * @fileoverview Система логирования для Chrome Extension
 * Поддерживает разные уровни логирования и сохранение в storage
 */

// Глобальный объект для логгера
window.LanguageTool = window.LanguageTool || {};

(function(exports) {
  'use strict';

  /**
   * Уровни логирования
   */
  const LEVELS = {
    DEBUG: 0,
    LOG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4
  };

  /**
   * Класс Logger
   */
  class Logger {
    /**
     * @param {string} context - контекст логгера
     */
    constructor(context = 'app') {
      this.context = context;
      this.enabled = true;
      this.logLevel = LEVELS.INFO;
      this.maxStoredLogs = 1000;
    }

    /**
     * Форматирование сообщения
     */
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

    /**
     * Отправка лога в консоль
     */
    logToConsole(level, args) {
      const prefix = `[${this.context}]`;
      const consoleMethod = level.toLowerCase();
      
      if (console[consoleMethod]) {
        console[consoleMethod](prefix, ...args);
      } else {
        console.log(prefix, ...args);
      }
    }

    /**
     * Сохранение лога в storage
     */
    async saveToStorage(logEntry) {
      try {
        const storage = await chrome.storage.local.get(['logs']);
        const logs = storage.logs || [];
        
        logs.push(logEntry);
        
        if (logs.length > this.maxStoredLogs) {
          logs.shift();
        }
        
        await chrome.storage.local.set({ logs });
      } catch (error) {
        console.error('[Logger] Ошибка сохранения лога:', error);
      }
    }

    /**
     * Основная функция логирования
     */
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

    setEnabled(enabled) { this.enabled = enabled; }
    setLogLevel(level) {
      if (LEVELS[level] !== undefined) {
        this.logLevel = LEVELS[level];
        this.info(`Уровень логирования установлен: ${level}`);
      }
    }
  }

  // Экспорт в глобальный объект
  exports.Logger = Logger;
  exports.logger = new Logger('global');

})(window.LanguageTool);
