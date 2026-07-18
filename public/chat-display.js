/**
 * Pure chat UI helpers (ask-mode conversations).
 * @author Amadeus
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.ChatDisplay = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMarkdown(value) {
    if (typeof window !== 'undefined' && window.TaskDisplay?.formatMarkdown) {
      return window.TaskDisplay.formatMarkdown(value);
    }
    return `<pre>${escapeHtml(value)}</pre>`;
  }

  function renderMessageBubble(message, options = {}) {
    const role = message.role || 'assistant';
    const content = message.content || '';
    const body = role === 'assistant'
      ? `<div class="markdown">${formatMarkdown(content)}</div>`
      : `<div class="chat-text">${escapeHtml(content)}</div>`;
    return `
      <div class="chat-bubble ${role}${options.streaming ? ' streaming' : ''}">
        <div class="chat-bubble-label">${role === 'user' ? '你' : 'Agent'}</div>
        ${body}
      </div>`;
  }

  function renderStreamingBubble(chunks) {
    const text = Array.isArray(chunks) ? chunks.join('') : String(chunks || '');
    if (!text) {
      return `
        <div class="chat-bubble assistant streaming">
          <div class="chat-bubble-label">Agent</div>
          <div class="chat-typing"><span></span><span></span><span></span></div>
        </div>`;
    }
    return renderMessageBubble({ role: 'assistant', content: text }, { streaming: true });
  }

  function renderInteraction(interaction) {
    if (!interaction || interaction.type !== 'question') return '';
    return `
      <div class="interaction chat-interaction">
        <h3>${escapeHtml(interaction.title || '需要你的回答')}</h3>
        ${(interaction.questions || []).map((question) => `
          <div class="question" data-chat-question="${escapeHtml(question.id)}" data-multiple="${question.allowMultiple ? '1' : '0'}">
            <p><strong>${escapeHtml(question.prompt)}</strong></p>
            ${(question.options || []).map((option) => `
              <label class="option">
                <input type="${question.allowMultiple ? 'checkbox' : 'radio'}" name="chat-q-${escapeHtml(question.id)}" value="${escapeHtml(option.id)}" />
                ${escapeHtml(option.label)}
              </label>`).join('')}
          </div>`).join('')}
        <button type="button" class="primary" data-chat-submit-interaction>提交回答</button>
      </div>`;
  }

  function renderSessionListItem(session, active) {
    const title = session.title || '新对话';
    const status = session.status === 'running'
      ? '回复中…'
      : (session.status === 'awaiting_input' ? '待回答' : '');
    return `
      <button type="button" class="rules-list-item chat-session-item${active ? ' active' : ''}" data-chat-session="${escapeHtml(session.id)}">
        <div class="name">${escapeHtml(title)}</div>
        <div class="meta">${escapeHtml(session.updated_at || session.created_at || '')}${status ? ` · ${escapeHtml(status)}` : ''}</div>
      </button>`;
  }

  return {
    escapeHtml,
    formatMarkdown,
    renderMessageBubble,
    renderStreamingBubble,
    renderInteraction,
    renderSessionListItem,
  };
}));
