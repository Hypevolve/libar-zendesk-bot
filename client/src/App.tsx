import { useEffect, useMemo, useRef, useState } from "react";
import {
  Paperclip,
  SendHorizontal,
  X,
  MessageCircleMore,
  Circle,
  Plus,
  Loader2,
  FileText,
  Image as ImageIcon
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Attachment = {
  id: string | number;
  name: string;
  contentType?: string;
  size?: number;
  url?: string | null;
};

type ChatMessage = {
  id: string | number;
  role: "assistant" | "user" | "system";
  content: string;
  createdAt: string;
  attachments?: Attachment[];
};

type SessionResponse = {
  success: boolean;
  session?: {
    messages: ChatMessage[];
  };
};

type StartResponse = {
  success: boolean;
  sessionId: string;
  ticketId: number;
  messages: ChatMessage[];
};

const STORAGE_KEY = "libar-chat-session-id";
const ONBOARDING_KEY = "libar-chat-onboarding-v2";

function formatTime(dateIso: string) {
  return new Date(dateIso).toLocaleTimeString("hr-HR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatFileSize(size?: number) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function attachmentIcon(contentType?: string) {
  if (contentType?.startsWith("image/")) {
    return <ImageIcon className="h-4 w-4" />;
  }

  return <FileText className="h-4 w-4" />;
}

function messageSignature(messages: ChatMessage[]) {
  return messages
    .map((message) => `${message.id}:${message.createdAt}:${message.content}:${message.attachments?.length || 0}`)
    .join("|");
}

export default function App() {
  const [isOpen, setIsOpen] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(localStorage.getItem(STORAGE_KEY));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const [typing, setTyping] = useState(false);
  const [stage, setStage] = useState<"initial" | "awaiting_name" | "awaiting_email" | "starting" | "connected">("initial");
  const [draftLead, setDraftLead] = useState({
    firstMessage: "",
    name: "",
    email: ""
  });
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const signatureRef = useRef("");

  const launcherBadge = useMemo(
    () => (sessionId ? "Aktivan razgovor" : "Online sada"),
    [sessionId]
  );

  useEffect(() => {
    const storedOnboarding = localStorage.getItem(ONBOARDING_KEY);

    if (storedOnboarding && !sessionId) {
      try {
        const parsed = JSON.parse(storedOnboarding);
        setMessages(parsed.messages || []);
        setStage(parsed.stage || "initial");
        setDraftLead(parsed.draftLead || { firstMessage: "", name: "", email: "" });
        signatureRef.current = messageSignature(parsed.messages || []);
      } catch {
        localStorage.removeItem(ONBOARDING_KEY);
      }
    } else if (!sessionId) {
      const welcome = [
        {
          id: "welcome",
          role: "assistant" as const,
          content: "Pozdrav! Ja sam Libar Agent. Kako vam mogu pomoći?",
          createdAt: new Date().toISOString()
        }
      ];
      setMessages(welcome);
      signatureRef.current = messageSignature(welcome);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      localStorage.setItem(
        ONBOARDING_KEY,
        JSON.stringify({
          stage,
          draftLead,
          messages
        })
      );
    }
  }, [draftLead, messages, sessionId, stage]);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    const sync = async () => {
      try {
        const response = await fetch(`/api/chat/session/${sessionId}`);
        const data: SessionResponse = await response.json();

        if (!response.ok || !data.session || cancelled) {
          return;
        }

        const nextSignature = messageSignature(data.session.messages);

        if (nextSignature !== signatureRef.current) {
          signatureRef.current = nextSignature;
          setMessages(data.session.messages);
        }
      } catch {
        if (!cancelled) {
          setError("Ne mogu osvježiti razgovor.");
        }
      }
    };

    const intervalId = window.setInterval(sync, 3500);
    sync();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [sessionId]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;

    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages, isOpen]);

  function pushMessage(message: ChatMessage) {
    setMessages((current) => {
      const next = [...current, message];
      signatureRef.current = messageSignature(next);
      return next;
    });
  }

  function removeQueuedFile(index: number) {
    setQueuedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
  }

  function handleFilesSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    setQueuedFiles((current) => [...current, ...files].slice(0, 5));

    if (event.target) {
      event.target.value = "";
    }
  }

  async function handleOnboarding(message: string) {
    if (stage === "initial") {
      setDraftLead((current) => ({ ...current, firstMessage: message }));
      setStage("awaiting_name");
      pushMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "Za početak, recite mi svoje ime i prezime.",
        createdAt: new Date().toISOString()
      });
      return;
    }

    if (stage === "awaiting_name") {
      setDraftLead((current) => ({ ...current, name: message }));
      setStage("awaiting_email");
      pushMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "Hvala. Na koji email vas možemo kontaktirati ako zatreba nastavak razgovora?",
        createdAt: new Date().toISOString()
      });
      return;
    }

    if (stage === "awaiting_email") {
      if (!/\S+@\S+\.\S+/.test(message)) {
        pushMessage({
          id: crypto.randomUUID(),
          role: "system",
          content: "Molim unesite ispravnu email adresu, npr. ime@domena.com.",
          createdAt: new Date().toISOString()
        });
        return;
      }

      const nextLead = {
        ...draftLead,
        email: message
      };
      setDraftLead(nextLead);
      setStage("starting");
      setTyping(true);

      try {
        const payload = new FormData();
        payload.append("name", nextLead.name);
        payload.append("email", nextLead.email);
        payload.append("message", nextLead.firstMessage);
        queuedFiles.forEach((file) => payload.append("attachments", file));

        const response = await fetch("/api/chat/start", {
          method: "POST",
          body: payload
        });

        const data: StartResponse = await response.json();

        if (!response.ok) {
          throw new Error("Pokretanje chata nije uspjelo.");
        }

        localStorage.setItem(STORAGE_KEY, data.sessionId);
        localStorage.removeItem(ONBOARDING_KEY);
        setSessionId(data.sessionId);
        setQueuedFiles([]);
        setStage("connected");
        setMessages(data.messages);
        signatureRef.current = messageSignature(data.messages);
      } catch (error) {
        setStage("awaiting_email");
        setError(error instanceof Error ? error.message : "Pokretanje chata nije uspjelo.");
      } finally {
        setTyping(false);
      }
    }
  }

  async function sendConnectedMessage(message: string) {
    if (!sessionId) return;

    setTyping(true);

    try {
      const payload = new FormData();
      payload.append("sessionId", sessionId);
      if (message.trim()) {
        payload.append("message", message);
      }
      queuedFiles.forEach((file) => payload.append("attachments", file));

      const response = await fetch("/api/chat/message", {
        method: "POST",
        body: payload
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Slanje poruke nije uspjelo.");
      }

      setQueuedFiles([]);
      setMessages(data.messages);
      signatureRef.current = messageSignature(data.messages);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Slanje poruke nije uspjelo.");
    } finally {
      setTyping(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    const message = composer.trim();

    if (!message && queuedFiles.length === 0) {
      return;
    }

    pushMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: message || "Poslan je privitak.",
      createdAt: new Date().toISOString(),
      attachments: queuedFiles.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        contentType: file.type,
        size: file.size
      }))
    });
    setComposer("");
    setIsSending(true);

    try {
      if (!sessionId) {
        await handleOnboarding(message || "Poslao/la sam privitak.");
      } else {
        await sendConnectedMessage(message);
      }
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="fixed inset-0 pointer-events-none">
      <div className="pointer-events-auto fixed bottom-6 right-6 z-50 flex flex-col items-end gap-4">
        {isOpen ? (
          <Card className="h-[720px] w-[420px] overflow-hidden rounded-[30px] border-white/60 bg-card/95 backdrop-blur-xl max-md:h-[100dvh] max-md:w-screen max-md:rounded-none">
            <CardContent className="flex h-full flex-col">
              <div className="flex items-start justify-between border-b border-border/80 px-5 py-4">
                <div className="flex items-start gap-3">
                  <Avatar className="h-11 w-11 ring-4 ring-primary/10">
                    <AvatarFallback className="bg-primary/10 text-primary">LA</AvatarFallback>
                  </Avatar>
                  <div className="space-y-1">
                    <Badge className="w-fit bg-primary/10 text-primary hover:bg-primary/10">
                      ANTIKVARIJAT LIBAR
                    </Badge>
                    <div className="space-y-0.5">
                      <h1 className="text-[1.55rem] font-semibold tracking-[-0.04em] text-foreground">
                        Razgovor s podrškom
                      </h1>
                      <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                        <Circle className="h-2.5 w-2.5 fill-emerald-500 text-emerald-500" />
                        Agent dostupan sada
                      </div>
                    </div>
                  </div>
                </div>

                <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)}>
                  <X className="h-5 w-5" />
                </Button>
              </div>

              <div className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Pitaj za knjige, otkup ili narudžbu</p>
                  <p className="text-xs text-muted-foreground">Odgovor odmah u chatu, agent se može uključiti u razgovor.</p>
                </div>
                <Badge variant="secondary">{launcherBadge}</Badge>
              </div>

              <Separator />

              <div ref={scrollViewportRef} className="min-h-0 flex-1 overflow-y-auto px-4">
                <div className="space-y-4 py-4">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        "flex w-full",
                        message.role === "user" ? "justify-end" : message.role === "system" ? "justify-center" : "justify-start"
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[85%] rounded-[24px] px-4 py-3 shadow-soft",
                          message.role === "user" && "rounded-br-md bg-primary text-primary-foreground",
                          message.role === "assistant" &&
                            "rounded-bl-md border border-border/60 bg-secondary text-secondary-foreground",
                          message.role === "system" &&
                            "max-w-[92%] rounded-full border border-border/80 bg-background px-3 py-2 text-center text-sm text-muted-foreground shadow-none"
                        )}
                      >
                        <p className="whitespace-pre-wrap text-[15px] leading-6">{message.content}</p>

                        {message.attachments && message.attachments.length > 0 ? (
                          <div className="mt-3 space-y-2">
                            {message.attachments.map((attachment) => (
                              <a
                                key={attachment.id}
                                href={attachment.url || "#"}
                                target="_blank"
                                rel="noreferrer"
                                className={cn(
                                  "flex items-center gap-3 rounded-2xl border px-3 py-2 text-sm",
                                  message.role === "user"
                                    ? "border-white/20 bg-white/10"
                                    : "border-border/70 bg-background"
                                )}
                              >
                                <span className="grid h-9 w-9 place-items-center rounded-xl bg-background/80 text-foreground">
                                  {attachmentIcon(attachment.contentType)}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">{attachment.name}</span>
                                  <span className="block text-xs opacity-70">{formatFileSize(attachment.size)}</span>
                                </span>
                              </a>
                            ))}
                          </div>
                        ) : null}

                        <div
                          className={cn(
                            "mt-2 text-[11px]",
                            message.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"
                          )}
                        >
                          {message.role === "assistant"
                            ? `Agent podrške • ${formatTime(message.createdAt)}`
                            : message.role === "user"
                              ? `Vi • ${formatTime(message.createdAt)}`
                              : formatTime(message.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}

                  {typing ? (
                    <div className="flex justify-start">
                      <div className="rounded-full border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground shadow-soft">
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Agent tipka...
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <Separator />

              <div className="space-y-3 p-4">
                {queuedFiles.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {queuedFiles.map((file, index) => (
                      <div
                        key={`${file.name}-${index}`}
                        className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
                      >
                        {attachmentIcon(file.type)}
                        <span className="max-w-[180px] truncate">{file.name}</span>
                        <button type="button" onClick={() => removeQueuedFile(index)}>
                          <X className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {error ? (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </div>
                ) : null}

                <form onSubmit={handleSubmit} className="rounded-[28px] border border-border bg-muted/70 p-3">
                  <Textarea
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    placeholder="Napišite poruku"
                    className="min-h-[76px] border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
                  />

                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        multiple
                        accept="image/*,.pdf,.doc,.docx,.txt"
                        onChange={handleFilesSelected}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>

                    <Button type="submit" disabled={isSending}>
                      {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                      Pošalji
                    </Button>
                  </div>
                </form>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Button
          size="default"
          onClick={() => setIsOpen((current) => !current)}
          className="rounded-full px-5 shadow-widget"
        >
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-300" />
          <MessageCircleMore className="h-4 w-4" />
          Pitaj Libar
        </Button>
      </div>
    </div>
  );
}
