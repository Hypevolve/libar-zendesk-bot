const storageKey = "libar-chat-session-id";
const onboardingKey = "libar-chat-onboarding";

const launcher = document.getElementById("chat-launcher");
const widget = document.getElementById("chat-widget");
const closeButton = document.getElementById("chat-close");
const messageForm = document.getElementById("message-form");
const messagesEl = document.getElementById("messages");
const errorBox = document.getElementById("error-box");
const messageInput = document.getElementById("message-input");
let pollTimer = null;
let lastRenderedSignature = "";

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
    createdAt
  };
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
    .map((message) => `${message.id}:${message.createdAt}:${message.content}`)
    .join("|");
}

function createMessageElement(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}`;
  wrapper.dataset.messageId = String(message.id);
  wrapper.textContent = message.content;

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

function pushMessage(role, content) {
  onboarding.messages.push(createMessage(role, content));
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
  const payload = {
    name: onboarding.draft.name,
    email: onboarding.draft.email,
    message: onboarding.draft.firstMessage
  };

  const response = await fetch("/api/chat/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Pokretanje chata nije uspjelo.");
  }

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

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const sessionId = localStorage.getItem(storageKey);
  const message = messageInput.value.trim();

  if (!message) {
    return;
  }

  pushMessage("user", message);
  messageInput.value = "";
  messageInput.style.height = "auto";

  if (!sessionId) {
    await handleOnboardingMessage(message);
    return;
  }

  try {
    const response = await fetch("/api/chat/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId,
        message
      })
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
