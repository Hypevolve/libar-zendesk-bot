const storageKey = "libar-chat-session-id";
const onboardingKey = "libar-chat-onboarding";

const launcher = document.getElementById("chat-launcher");
const widget = document.getElementById("chat-widget");
const closeButton = document.getElementById("chat-close");
const messageForm = document.getElementById("message-form");
const messagesEl = document.getElementById("messages");
const errorBox = document.getElementById("error-box");
const messageInput = document.getElementById("message-input");
const fileInput = document.getElementById("file-input");
const imageInput = document.getElementById("image-input");
const filesIndicator = document.getElementById("pending-files-indicator");
const pendingFilesList = document.getElementById("pending-files-list");
let pollTimer = null;
let lastRenderedSignature = "";
let pendingFiles = [];

const onboarding = {
  stage: "initial",
  draft: {
    firstMessage: "",
    name: "",
    email: ""
  },
  messages: []
};

function showWidget() {
  widget.classList.remove("hidden");
  widget.setAttribute("aria-hidden", "false");
  launcher.setAttribute("aria-expanded", "true");
  messageInput.focus();
}

function hideWidget() {
  widget.classList.add("hidden");
  widget.setAttribute("aria-hidden", "true");
  launcher.setAttribute("aria-expanded", "false");
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function formatTime(dateIso) {
  return new Date(dateIso).toLocaleTimeString("hr-HR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function createMessage(role, content, createdAt = new Date().toISOString()) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt,
    attachments: []
  };
}

function formatFileSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function saveOnboardingState() {
  localStorage.setItem(onboardingKey, JSON.stringify(onboarding));
}

function clearOnboardingState() {
  localStorage.removeItem(onboardingKey);
}

function renderMessages(messages) {
  messagesEl.innerHTML = "";

  for (const message of messages) {
    messagesEl.appendChild(createMessageElement(message));
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function getMessagesSignature(messages) {
  return messages
    .map((message) =>
      `${message.id}:${message.createdAt}:${message.content}:${(message.attachments || [])
        .map((attachment) => `${attachment.id || attachment.name}:${attachment.name}`)
        .join(",")}`
    )
    .join("|");
}

function createMessageElement(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}`;
  wrapper.dataset.messageId = String(message.id);

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = message.content;
  wrapper.appendChild(content);

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (attachments.length > 0) {
    const attachmentsEl = document.createElement("div");
    attachmentsEl.className = "message-attachments";

    attachments.forEach((attachment) => {
      const attachmentEl = document.createElement(attachment.url ? "a" : "div");
      attachmentEl.className = "message-attachment";

      if (attachment.url) {
        attachmentEl.href = attachment.url;
        attachmentEl.target = "_blank";
        attachmentEl.rel = "noopener noreferrer";
      }

      const icon = document.createElement("div");
      icon.className = "message-attachment__icon";
      icon.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9.5 14.5 12 12l2.5 2.5"/></svg>';

      const meta = document.createElement("div");
      meta.className = "message-attachment__meta";

      const name = document.createElement("span");
      name.className = "message-attachment__name";
      name.textContent = attachment.name || "Privitak";

      const info = document.createElement("span");
      info.className = "message-attachment__info";
      info.textContent = attachment.size ? formatFileSize(attachment.size) : "Privitak";

      meta.appendChild(name);
      meta.appendChild(info);
      attachmentEl.appendChild(icon);
      attachmentEl.appendChild(meta);
      attachmentsEl.appendChild(attachmentEl);
    });

    wrapper.appendChild(attachmentsEl);
  }

  const meta = document.createElement("div");
  meta.className = "message-meta";

  if (message.role === "assistant") {
    meta.textContent = `Agent podrške • ${formatTime(message.createdAt)}`;
  } else if (message.role === "system") {
    meta.textContent = formatTime(message.createdAt);
  } else {
    meta.textContent = `Vi • ${formatTime(message.createdAt)}`;
  }

  wrapper.appendChild(meta);
  return wrapper;
}

function updateMessages(messages) {
  const nextSignature = getMessagesSignature(messages);

  if (nextSignature === lastRenderedSignature) {
    return;
  }

  const isNearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;

  if (!lastRenderedSignature || messagesEl.children.length === 0) {
    renderMessages(messages);
    lastRenderedSignature = nextSignature;
    return;
  }

  const currentIds = Array.from(messagesEl.children).map((node) => node.dataset.messageId);
  const nextIds = messages.map((message) => String(message.id));
  const canAppendOnly =
    currentIds.every((id, index) => id === nextIds[index]) &&
    nextIds.length >= currentIds.length;

  if (!canAppendOnly) {
    renderMessages(messages);
    lastRenderedSignature = nextSignature;
    return;
  }

  const newMessages = messages.slice(currentIds.length);

  for (const message of newMessages) {
    messagesEl.appendChild(createMessageElement(message));
  }

  if (isNearBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  lastRenderedSignature = nextSignature;
}

function startPolling() {
  if (pollTimer || !localStorage.getItem(storageKey)) {
    return;
  }

  pollTimer = window.setInterval(async () => {
    const sessionId = localStorage.getItem(storageKey);

    if (!sessionId) {
      stopPolling();
      return;
    }

    try {
      const response = await fetch(`/api/chat/session/${sessionId}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Osvježavanje razgovora nije uspjelo.");
      }

      onboarding.stage = "connected";
      updateMessages(data.session.messages);
    } catch (error) {
      showError(error.message);
    }
  }, 4000);
}

function stopPolling() {
  if (!pollTimer) {
    return;
  }

  window.clearInterval(pollTimer);
  pollTimer = null;
}

function setMessages(messages) {
  onboarding.messages = messages;
  updateMessages(messages);
  saveOnboardingState();
}

function pushMessage(role, content, attachments = []) {
  const message = createMessage(role, content);
  message.attachments = attachments;
  onboarding.messages.push(message);
  updateMessages(onboarding.messages);
  saveOnboardingState();
}

function seedWelcomeState() {
  if (onboarding.messages.length > 0) {
    return;
  }

  setMessages([
    createMessage(
      "assistant",
      "Pozdrav! Ja sam Libar Agent. Kako vam mogu pomoći danas?"
    )
  ]);
}

function isValidEmail(value) {
  return /\S+@\S+\.\S+/.test(value);
}

async function startZendeskChat() {
  const isForm = pendingFiles.length > 0;
  let body;
  let headers = {};

  if (isForm) {
    body = new FormData();
    body.append("name", onboarding.draft.name);
    body.append("email", onboarding.draft.email);
    body.append("message", onboarding.draft.firstMessage);
    for (const file of pendingFiles) {
      body.append("attachments", file);
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      name: onboarding.draft.name,
      email: onboarding.draft.email,
      message: onboarding.draft.firstMessage
    });
  }

  const response = await fetch("/api/chat/start", {
    method: "POST",
    headers,
    body
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Pokretanje chata nije uspjelo.");
  }

  pendingFiles = [];
  renderPendingFiles();
  localStorage.setItem(storageKey, data.sessionId);
  clearOnboardingState();
  onboarding.stage = "connected";
  updateMessages(data.messages);
  startPolling();
}

async function handleOnboardingMessage(message) {
  if (onboarding.stage === "initial") {
    onboarding.draft.firstMessage = message;
    onboarding.stage = "awaiting_name";
    pushMessage("system", "Za početak, recite mi svoje ime i prezime.");
    return;
  }

  if (onboarding.stage === "awaiting_name") {
    onboarding.draft.name = message;
    onboarding.stage = "awaiting_email";
    pushMessage("system", "Hvala. Na koji email vas možemo kontaktirati ako zatreba nastavak razgovora?");
    return;
  }

  if (onboarding.stage === "awaiting_email") {
    if (!isValidEmail(message)) {
      pushMessage("system", "Molim unesite ispravnu email adresu, npr. ime@domena.com.");
      return;
    }

    onboarding.draft.email = message;
    onboarding.stage = "starting";
    pushMessage("system", "Odlično, povezujem razgovor s podrškom...");

    try {
      await startZendeskChat();
    } catch (error) {
      onboarding.stage = "awaiting_email";
      showError(error.message);
    }
  }
}

async function loadExistingSession() {
  const sessionId = localStorage.getItem(storageKey);

  if (sessionId) {
    try {
      const response = await fetch(`/api/chat/session/${sessionId}`);
      const data = await response.json();

      if (response.ok) {
        onboarding.stage = "connected";
        updateMessages(data.session.messages);
        startPolling();
        return;
      }

      localStorage.removeItem(storageKey);
    } catch (error) {
      showError("Ne mogu učitati prethodni razgovor.");
      return;
    }
  }

  const savedOnboarding = localStorage.getItem(onboardingKey);

  if (savedOnboarding) {
    try {
      const parsed = JSON.parse(savedOnboarding);
      onboarding.stage = parsed.stage || "initial";
      onboarding.draft = parsed.draft || onboarding.draft;
      onboarding.messages = parsed.messages || [];
    } catch (error) {
      clearOnboardingState();
    }
  }

  seedWelcomeState();
  updateMessages(onboarding.messages);
}

launcher.addEventListener("click", () => {
  if (widget.classList.contains("hidden")) {
    showWidget();
    return;
  }

  hideWidget();
});

closeButton.addEventListener("click", hideWidget);

function collectPendingFiles(inputEl) {
  if (!inputEl || !inputEl.files) {
    return;
  }

  for (const file of inputEl.files) {
    const duplicate = pendingFiles.some(
      (pendingFile) =>
        pendingFile.name === file.name &&
        pendingFile.size === file.size &&
        pendingFile.lastModified === file.lastModified
    );

    if (!duplicate) {
      pendingFiles.push(file);
    }
  }

  inputEl.value = "";
  renderPendingFiles();
}

function renderPendingFiles() {
  if (!filesIndicator || !pendingFilesList) return;

  if (pendingFiles.length === 0) {
    filesIndicator.classList.add("hidden");
    filesIndicator.textContent = "";
    pendingFilesList.classList.add("hidden");
    pendingFilesList.innerHTML = "";
    return;
  }

  filesIndicator.classList.remove("hidden");
  if (pendingFiles.length === 1) {
    filesIndicator.textContent = "1 datoteka";
  } else if (pendingFiles.length < 5) {
    filesIndicator.textContent = `${pendingFiles.length} datoteke`;
  } else {
    filesIndicator.textContent = `${pendingFiles.length} datoteka`;
  }

  pendingFilesList.classList.remove("hidden");
  pendingFilesList.innerHTML = "";

  pendingFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "pending-file";

    const meta = document.createElement("div");
    meta.className = "pending-file__meta";

    const name = document.createElement("span");
    name.className = "pending-file__name";
    name.textContent = file.name;
    name.title = file.name;

    const size = document.createElement("span");
    size.className = "pending-file__size";
    size.textContent = formatFileSize(file.size);

    meta.appendChild(name);
    meta.appendChild(size);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "pending-file__remove";
    removeButton.setAttribute("aria-label", `Ukloni ${file.name}`);
    removeButton.dataset.fileIndex = String(index);
    removeButton.innerHTML = "&times;";

    item.appendChild(meta);
    item.appendChild(removeButton);

    pendingFilesList.appendChild(item);
  });
}

function removePendingFile(index) {
  pendingFiles = pendingFiles.filter((_, fileIndex) => fileIndex !== index);
  renderPendingFiles();
}

if (fileInput) {
  fileInput.addEventListener("change", () => {
    collectPendingFiles(fileInput);
  });
}

if (imageInput) {
  imageInput.addEventListener("change", () => {
    collectPendingFiles(imageInput);
  });
}

if (pendingFilesList) {
  pendingFilesList.addEventListener("click", (event) => {
    const target = event.target.closest(".pending-file__remove");

    if (!target) {
      return;
    }

    const index = Number(target.dataset.fileIndex);

    if (Number.isNaN(index)) {
      return;
    }

    removePendingFile(index);
  });
}

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const sessionId = localStorage.getItem(storageKey);
  const message = messageInput.value.trim();

  if (!message && pendingFiles.length === 0) {
    return;
  }

  const pendingAttachmentPayload = pendingFiles.map((file) => ({
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    size: file.size,
    contentType: file.type || "application/octet-stream",
    url: null
  }));

  if (message) {
    pushMessage("user", message, pendingAttachmentPayload);
  } else if (pendingAttachmentPayload.length > 0) {
    pushMessage("user", "Poslan je privitak.", pendingAttachmentPayload);
  }

  messageInput.value = "";
  messageInput.style.height = "auto";

  if (!sessionId) {
    if (message) {
      await handleOnboardingMessage(message);
    }
    // Do NOT clear pendingFiles here anymore! They need to persist until startZendeskChat
    return;
  }

  try {
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    formData.append("message", message);

    for (const file of pendingFiles) {
      formData.append("attachments", file);
    }

    pendingFiles = [];
    renderPendingFiles();

    const response = await fetch("/api/chat/message", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Slanje poruke nije uspjelo.");
    }

    updateMessages(data.messages);
    startPolling();
  } catch (error) {
    showError(error.message);
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 132)}px`;
});

loadExistingSession();
