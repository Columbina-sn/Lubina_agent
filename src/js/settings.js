/* ============================================================
   settings.js —— 设置页逻辑
   API Key · 模型选择 · 主题切换 · 持久化
   ============================================================ */

const Settings = (() => {
  function mount() {
    loadSettings();
  }

  function destroy() {
    // 设置页无需特殊清理
  }

  function loadSettings() {
    const theme = localStorage.getItem('lubina_theme') || 'auto';
    const themeSelect = document.getElementById('settingTheme');
    const deepseekKey = document.getElementById('settingDeepseekKey');
    const openaiKey = document.getElementById('settingOpenaiKey');
    const claudeKey = document.getElementById('settingClaudeKey');
    const defaultModel = document.getElementById('settingDefaultModel');
    const maxTurns = document.getElementById('settingMaxTurns');

    if (themeSelect) themeSelect.value = theme;
    if (deepseekKey) deepseekKey.value = localStorage.getItem('lubina_key_deepseek') || '';
    if (openaiKey) openaiKey.value = localStorage.getItem('lubina_key_openai') || '';
    if (claudeKey) claudeKey.value = localStorage.getItem('lubina_key_claude') || '';
    if (defaultModel) defaultModel.value = localStorage.getItem('lubina_model') || 'deepseek-chat';
    if (maxTurns) maxTurns.value = localStorage.getItem('lubina_max_turns') || '15';
  }

  function save() {
    const deepseekKey = document.getElementById('settingDeepseekKey')?.value || '';
    const openaiKey = document.getElementById('settingOpenaiKey')?.value || '';
    const claudeKey = document.getElementById('settingClaudeKey')?.value || '';
    const defaultModel = document.getElementById('settingDefaultModel')?.value || 'deepseek-chat';
    const theme = document.getElementById('settingTheme')?.value || 'auto';
    const maxTurns = document.getElementById('settingMaxTurns')?.value || '15';

    localStorage.setItem('lubina_key_deepseek', deepseekKey);
    localStorage.setItem('lubina_key_openai', openaiKey);
    localStorage.setItem('lubina_key_claude', claudeKey);
    localStorage.setItem('lubina_model', defaultModel);
    localStorage.setItem('lubina_theme', theme);
    localStorage.setItem('lubina_max_turns', maxTurns);

    // 应用主题
    if (typeof App !== 'undefined') {
      App.applyTheme(theme);
    }

    // 反馈（按钮文字变化）
    const saveBtn = document.querySelector('#settingsPage .btn-primary') || document.querySelector('.btn-primary.btn-lg');
    if (saveBtn) {
      const orig = saveBtn.textContent;
      saveBtn.textContent = '已保存';
      saveBtn.style.background = 'linear-gradient(135deg, #3DA55D, #4DB868)';
      setTimeout(() => {
        saveBtn.textContent = orig;
        saveBtn.style.background = '';
      }, 1500);
    }
  }

  function toggleVisible(inputId) {
    const el = document.getElementById(inputId);
    if (el) {
      el.type = el.type === 'password' ? 'text' : 'password';
    }
  }

  return {
    mount,
    destroy,
    loadSettings,
    save,
    toggleVisible,
  };
})();
