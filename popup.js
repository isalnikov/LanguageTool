/**
 * @fileoverview Скрипт для popup страницы расширения
 */

class PopupManager {
  constructor() {
    this.elements = {};
    this.init();
  }

  async init() {
    console.log('[popup] Инициализация...');
    this.cacheElements();
    this.attachEventListeners();
    await this.updateStatus();
    console.log('[popup] Инициализация завершена');
  }

  cacheElements() {
    this.elements = {
      statusIndicator: document.getElementById('status-indicator'),
      statusText: document.getElementById('status-text'),
      statusDetail: document.getElementById('status-detail'),
      enCount: document.getElementById('en-count'),
      ruCount: document.getElementById('ru-count'),
      totalCount: document.getElementById('total-count'),
      reloadBtn: document.getElementById('reload-btn'),
      exportLogsBtn: document.getElementById('export-logs-btn'),
      clearLogsBtn: document.getElementById('clear-logs-btn'),
      clearIgnoreBtn: document.getElementById('clear-ignore-btn'),
      ignoreList: document.getElementById('ignore-list'),
      preloadBtn: document.getElementById('preload-btn')
    };
  }

  attachEventListeners() {
    this.elements.reloadBtn?.addEventListener('click', () => this.handleReload());
    this.elements.exportLogsBtn?.addEventListener('click', () => this.handleExportLogs());
    this.elements.clearLogsBtn?.addEventListener('click', () => this.handleClearLogs());
    this.elements.clearIgnoreBtn?.addEventListener('click', () => this.handleClearIgnore());
    this.elements.preloadBtn?.addEventListener('click', () => this.handlePreload());
  }

  async updateStatus() {
    try {
      const status = await this.sendMessage({ type: 'GET_STATUS' });
      console.log('[popup] Статус:', status);
      
      const totalLoaded = status.totalLoaded || 0;
      const enLoaded = status.en?.loaded || false;
      const ruLoaded = status.ru?.loaded || false;
      
      if (enLoaded || ruLoaded) {
        this.setReadyStatus(status);
      } else {
        this.setNotLoadedStatus(status);
      }
    } catch (error) {
      console.error('[popup] Ошибка получения статуса:', error);
      this.setErrorStatus();
    }
  }

  setReadyStatus(status) {
    this.elements.statusIndicator.className = 'status-indicator ready';
    this.elements.statusText.textContent = 'Словари загружены';
    
    const enCount = status.en?.wordCount || 0;
    const ruCount = status.ru?.wordCount || 0;
    
    this.elements.statusDetail.textContent = 
      `EN: ${enCount.toLocaleString()}, RU: ${ruCount.toLocaleString()}`;
    
    this.elements.enCount.textContent = enCount.toLocaleString();
    this.elements.ruCount.textContent = ruCount.toLocaleString();
    this.elements.totalCount.textContent = (enCount + ruCount).toLocaleString();
  }

  setNotLoadedStatus(status) {
    this.elements.statusIndicator.className = 'status-indicator loading';
    this.elements.statusText.textContent = 'Словари не загружены';
    this.elements.statusDetail.textContent = 'Загрузка по требованию';
    
    this.elements.enCount.textContent = '0';
    this.elements.ruCount.textContent = '0';
    this.elements.totalCount.textContent = '0';
  }

  setErrorStatus() {
    this.elements.statusIndicator.className = 'status-indicator error';
    this.elements.statusText.textContent = 'Ошибка';
    this.elements.statusDetail.textContent = 'Проверьте консоль';
    
    this.elements.enCount.textContent = '0';
    this.elements.ruCount.textContent = '0';
    this.elements.totalCount.textContent = '0';
  }

  async handleReload() {
    console.log('[popup] Перезагрузка словарей...');
    
    this.setNotLoadedStatus();
    this.elements.reloadBtn.disabled = true;
    
    try {
      await this.sendMessage({ type: 'CLEAR_CACHE' });
      await this.updateStatus();
      this.showToast('Кэш очищен', 'success');
    } catch (error) {
      console.error('[popup] Ошибка:', error);
      this.setErrorStatus();
      this.showToast('Ошибка: ' + error.message, 'error');
    } finally {
      this.elements.reloadBtn.disabled = false;
    }
  }

  async handlePreload() {
    console.log('[popup] Предварительная загрузка...');
    
    this.elements.preloadBtn.disabled = true;
    this.elements.preloadBtn.textContent = 'Загрузка...';
    
    try {
      const result = await this.sendMessage({ type: 'PRELOAD_ALL' });
      console.log('[popup] Результат:', result);
      await this.updateStatus();
      this.showToast('Словари загружены', 'success');
    } catch (error) {
      console.error('[popup] Ошибка:', error);
      this.showToast('Ошибка: ' + error.message, 'error');
    } finally {
      this.elements.preloadBtn.disabled = false;
      this.elements.preloadBtn.textContent = 'Загрузить все словари';
    }
  }

  async handleExportLogs() {
    try {
      const logs = await this.sendMessage({ type: 'GET_LOGS' });
      
      if (!logs || logs.length === 0) {
        this.showToast('Нет логов', 'error');
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
      console.error('[popup] Ошибка экспорта:', error);
      this.showToast('Ошибка экспорта', 'error');
    }
  }

  async handleClearLogs() {
    try {
      await this.sendMessage({ type: 'CLEAR_LOGS' });
      this.showToast('Логи очищены', 'success');
    } catch (error) {
      console.error('[popup] Ошибка:', error);
      this.showToast('Ошибка очистки', 'error');
    }
  }

  async handleClearIgnore() {
    try {
      await chrome.storage.local.set({ ignoredWords: [] });
      this.showToast('Список исключений очищен', 'success');
    } catch (error) {
      console.error('[popup] Ошибка:', error);
      this.showToast('Ошибка очистки', 'error');
    }
  }

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

  showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

new PopupManager();
