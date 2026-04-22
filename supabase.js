(function () {
  const STORAGE_KEY_PREFIX = "iau-lite-supabase";

  function buildHeaders(apiKey, accessToken, extraHeaders) {
    const headers = {
      apikey: apiKey,
      "Content-Type": "application/json",
      ...extraHeaders
    };

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    return headers;
  }

  function parsePayload(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  class AuthClient {
    constructor(baseUrl, apiKey, storageKey) {
      this.baseUrl = baseUrl.replace(/\/$/, "");
      this.apiKey = apiKey;
      this.storageKey = storageKey;
      this.listeners = new Set();
    }

    _readSession() {
      try {
        const raw = localStorage.getItem(this.storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    _writeSession(session) {
      if (!session) {
        localStorage.removeItem(this.storageKey);
        return;
      }
      localStorage.setItem(this.storageKey, JSON.stringify(session));
    }

    _emit(eventName, session) {
      this.listeners.forEach(callback => {
        try {
          callback(eventName, session);
        } catch (error) {
          console.error("Auth listener error:", error);
        }
      });
    }

    async getSession() {
      return {
        data: {
          session: this._readSession()
        },
        error: null
      };
    }

    onAuthStateChange(callback) {
      this.listeners.add(callback);
      return {
        data: {
          subscription: {
            unsubscribe: () => this.listeners.delete(callback)
          }
        }
      };
    }

    async signInWithPassword({ email, password }) {
      try {
        const response = await fetch(`${this.baseUrl}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: buildHeaders(this.apiKey, null),
          body: JSON.stringify({ email, password })
        });

        const text = await response.text();
        const payload = parsePayload(text);

        if (!response.ok) {
          return {
            data: { session: null, user: null },
            error: {
              message: payload?.msg || payload?.error_description || payload?.message || "Login xatoligi."
            }
          };
        }

        const session = {
          access_token: payload.access_token,
          refresh_token: payload.refresh_token,
          expires_in: payload.expires_in,
          expires_at: payload.expires_at,
          token_type: payload.token_type,
          user: payload.user
        };

        this._writeSession(session);
        this._emit("SIGNED_IN", session);

        return {
          data: {
            session,
            user: payload.user
          },
          error: null
        };
      } catch (error) {
        return {
          data: { session: null, user: null },
          error: {
            message: error?.message || "Tarmoq xatoligi."
          }
        };
      }
    }

    async signOut() {
      const session = this._readSession();

      try {
        if (session?.access_token) {
          await fetch(`${this.baseUrl}/auth/v1/logout`, {
            method: "POST",
            headers: buildHeaders(this.apiKey, session.access_token)
          });
        }
      } catch (error) {
        console.warn("Sign out request warning:", error);
      }

      this._writeSession(null);
      this._emit("SIGNED_OUT", null);

      return {
        error: null
      };
    }
  }

  class QueryBuilder {
    constructor(client, tableName, action, payload, options) {
      this.client = client;
      this.tableName = tableName;
      this.action = action || "select";
      this.payload = payload;
      this.options = options || {};
      this.filters = [];
      this.orders = [];
      this.limitValue = null;
      this.selectValue = "*";
      this.returnRepresentation = this.action === "upsert";
    }

    select(columns) {
      this.selectValue = columns || "*";
      this.returnRepresentation = true;
      return this;
    }

    eq(column, value) {
      this.filters.push({ type: "eq", column, value });
      return this;
    }

    in(column, values) {
      this.filters.push({ type: "in", column, value: values });
      return this;
    }

    order(column, options) {
      this.orders.push({
        column,
        ascending: options?.ascending !== false
      });
      return this;
    }

    limit(value) {
      this.limitValue = value;
      return this;
    }

    then(onFulfilled, onRejected) {
      return this.execute().then(onFulfilled, onRejected);
    }

    async execute() {
      try {
        const url = new URL(`${this.client.restUrl}/${this.tableName}`);
        const session = this.client.auth._readSession();
        const accessToken = session?.access_token || this.client.apiKey;
        const headers = buildHeaders(this.client.apiKey, accessToken);
        const requestInit = {
          method: "GET",
          headers
        };

        url.searchParams.set("select", this.selectValue);

        this.filters.forEach(filter => {
          if (filter.type === "eq") {
            url.searchParams.append(filter.column, `eq.${filter.value}`);
          }

          if (filter.type === "in") {
            const values = Array.isArray(filter.value) ? filter.value : [filter.value];
            const joined = values.map(value => `${value}`).join(",");
            url.searchParams.append(filter.column, `in.(${joined})`);
          }
        });

        if (this.orders.length) {
          const orderValue = this.orders
            .map(order => `${order.column}.${order.ascending ? "asc" : "desc"}`)
            .join(",");
          url.searchParams.set("order", orderValue);
        }

        if (this.limitValue !== null) {
          url.searchParams.set("limit", String(this.limitValue));
        }

        if (this.action === "upsert") {
          requestInit.method = "POST";
          requestInit.body = JSON.stringify(this.payload);
          headers.Prefer = `resolution=merge-duplicates${this.returnRepresentation ? ",return=representation" : ""}`;

          if (this.options?.onConflict) {
            url.searchParams.set("on_conflict", this.options.onConflict);
          }
        }

        const response = await fetch(url.toString(), requestInit);
        const text = await response.text();
        const payload = parsePayload(text);

        if (!response.ok) {
          return {
            data: null,
            error: {
              message: payload?.message || payload?.error || payload?.hint || "Supabase so'rovida xatolik."
            }
          };
        }

        return {
          data: payload,
          error: null
        };
      } catch (error) {
        return {
          data: null,
          error: {
            message: error?.message || "Tarmoq xatoligi."
          }
        };
      }
    }
  }

  class LiteSupabaseClient {
    constructor(url, apiKey) {
      this.url = url.replace(/\/$/, "");
      this.apiKey = apiKey;
      this.restUrl = `${this.url}/rest/v1`;
      this.auth = new AuthClient(this.url, apiKey, `${STORAGE_KEY_PREFIX}:${this.url}`);
    }

    from(tableName) {
      return {
        select: columns => new QueryBuilder(this, tableName, "select").select(columns),
        upsert: (payload, options) => new QueryBuilder(this, tableName, "upsert", payload, options)
      };
    }
  }

  function createClient(url, apiKey) {
    if (!url || !apiKey) {
      throw new Error("Supabase url va key kerak.");
    }
    return new LiteSupabaseClient(url, apiKey);
  }

  window.supabase = {
    createClient
  };
})();
