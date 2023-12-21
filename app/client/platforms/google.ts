import {
  ApiPath,
  DEFAULT_API_HOST,
  DEFAULT_MODELS,
  GooglePath,
  OpenaiPath,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
} from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";

import {
  AgentChatOptions,
  ChatOptions,
  getGeminiHeaders,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "@/app/utils/format";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

export class GeminiApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();
    let baseUrl = ApiPath.GoogleAI;
    // if (baseUrl.length === 0) {
    //   const isApp = !!getClientConfig()?.isApp;
    //   baseUrl = isApp ? DEFAULT_API_HOST : ApiPath.OpenAI;
    // }

    // if (baseUrl.endsWith("/")) {
    //   baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    // }
    // if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.OpenAI)) {
    //   baseUrl = "https://" + baseUrl;
    // }

    // if (isAzure) {
    //   path = makeAzurePath(path, accessStore.azureApiVersion);
    // }

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  async chat(options: ChatOptions) {
    const messages: any[] = [];
    console.log(options.messages);
    let systemPrompt = "";
    for (const v of options.messages) {
      if (v.role === "system") {
        // systemPrompt = v.content;
        continue;
      }
      let content = v.content;
      if (systemPrompt !== "") {
        content = `${systemPrompt}\n${content}`;
        systemPrompt = "";
      }
      let message: {
        role: string;
        parts: { text: string }[];
      } = {
        role: v.role === "assistant" ? "model" : "user",
        parts: [],
      };
      message.parts.push({
        text: content,
      });
      messages.push(message);
    }

    const requestPayload = {
      contents: messages,
      generationConfig: {
        temperature: 1.0,
        maxOutputTokens: 8000,
        topP: 0.8,
        topK: 10,
      },
    };

    console.log("[Request] gemini payload: ", requestPayload);

    const shouldStream = true;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(
        GooglePath.ChatPath.replace("{{model}}", options.config.model),
      );
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getGeminiHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      if (shouldStream) {
        let responseText = "";
        let remainText = "";
        let finished = false;

        // animate response to make it looks smooth
        function animateResponseText() {
          if (finished || controller.signal.aborted) {
            responseText += remainText;
            console.log("[Response Animation] finished");
            return;
          }

          if (remainText.length > 0) {
            const fetchCount = Math.max(1, Math.round(remainText.length / 60));
            const fetchText = remainText.slice(0, fetchCount);
            responseText += fetchText;
            remainText = remainText.slice(fetchCount);
            options.onUpdate?.(responseText, fetchText);
          }

          requestAnimationFrame(animateResponseText);
        }

        // start animaion
        animateResponseText();

        const finish = () => {
          if (!finished) {
            finished = true;
            options.onFinish(responseText + remainText);
          }
        };

        controller.signal.onabort = finish;
        fetchEventSource(chatPath, {
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log(
              "[Google] request response content type: ",
              contentType,
            );

            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
              return finish();
            }

            if (
              !res.ok ||
              !res.headers
                .get("content-type")
                ?.startsWith(EventStreamContentType) ||
              res.status !== 200
            ) {
              const responseTexts = [responseText];
              let extraInfo = await res.clone().text();
              try {
                const resJson = await res.clone().json();
                extraInfo = prettyObject(resJson);
              } catch {}

              if (res.status === 401) {
                responseTexts.push(Locale.Error.Unauthorized);
              }

              if (extraInfo) {
                responseTexts.push(extraInfo);
              }

              responseText = responseTexts.join("\n\n");

              return finish();
            }
          },
          onmessage(msg) {
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            const text = msg.data;
            try {
              const json = JSON.parse(text) as {
                candidates: Array<{
                  content: {
                    parts: Array<{
                      text: string;
                    }>;
                  };
                }>;
              };
              const delta = json.candidates[0]?.content?.parts[0]?.text;
              if (delta) {
                remainText += delta;
              }
            } catch (e) {
              console.error("[Request] parse error", text);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async toolAgentChat(options: AgentChatOptions) {
    const messages = options.messages.map((v) => ({
      role: v.role,
      content: v.content,
    }));

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const requestPayload = {
      messages,
      stream: options.config.stream,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      presence_penalty: modelConfig.presence_penalty,
      frequency_penalty: modelConfig.frequency_penalty,
      top_p: modelConfig.top_p,
      baseUrl: useAccessStore.getState().openaiUrl,
      maxIterations: options.agentConfig.maxIterations,
      returnIntermediateSteps: options.agentConfig.returnIntermediateSteps,
      useTools: options.agentConfig.useTools,
    };

    console.log("[Request] openai payload: ", requestPayload);

    const shouldStream = true;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      let path = "/api/langchain/tool/agent/";
      const enableNodeJSPlugin = !!process.env.NEXT_PUBLIC_ENABLE_NODEJS_PLUGIN;
      path = enableNodeJSPlugin ? path + "nodejs" : path + "edge";
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      console.log("shouldStream", shouldStream);

      if (shouldStream) {
        let responseText = "";
        let finished = false;

        const finish = () => {
          if (!finished) {
            options.onFinish(responseText);
            finished = true;
          }
        };

        controller.signal.onabort = finish;

        fetchEventSource(path, {
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log(
              "[OpenAI] request response content type: ",
              contentType,
            );

            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
              return finish();
            }

            if (
              !res.ok ||
              !res.headers
                .get("content-type")
                ?.startsWith(EventStreamContentType) ||
              res.status !== 200
            ) {
              const responseTexts = [responseText];
              let extraInfo = await res.clone().text();
              console.warn(`extraInfo: ${extraInfo}`);
              // try {
              //   const resJson = await res.clone().json();
              //   extraInfo = prettyObject(resJson);
              // } catch { }

              if (res.status === 401) {
                responseTexts.push(Locale.Error.Unauthorized);
              }

              if (extraInfo) {
                responseTexts.push(extraInfo);
              }

              responseText = responseTexts.join("\n\n");

              return finish();
            }
          },
          onmessage(msg) {
            let response = JSON.parse(msg.data);
            if (!response.isSuccess) {
              console.error("[Request]", msg.data);
              responseText = msg.data;
              throw Error(response.message);
            }
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            try {
              if (response && !response.isToolMessage) {
                responseText += response.message;
                options.onUpdate?.(responseText, response.message);
              } else {
                options.onToolUpdate?.(response.toolName!, response.message);
              }
            } catch (e) {
              console.error("[Request] parse error", response, msg);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(path, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat reqeust", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    const chatModels = resJson.data?.filter((m) => m.id.startsWith("gpt-"));
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    return chatModels.map((m) => ({
      name: m.id,
      available: true,
    }));
  }
}
export { OpenaiPath };