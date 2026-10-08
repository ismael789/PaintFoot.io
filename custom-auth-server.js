const http = require("http");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const DEFAULT_AUTH_PORT = 4001;
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 16 * 1024;

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-PaintFoot-Server": "auth-api",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    request.on("error", reject);
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, expectedHash, salt) {
  const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createAuthStore() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      "[Auth] Define SUPABASE_SECRET_KEY en .env.local para habilitar registro y login.",
    );
    return null;
  }
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return {
    async findUserByEmail(email) {
      const { data, error } = await client
        .from("paintfoot_users")
        .select("id,email,name,age,password_hash,password_salt")
        .eq("email", email)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async createUser(name, age, email, password) {
      const { hash, salt } = hashPassword(password);
      const { data, error } = await client
        .from("paintfoot_users")
        .insert({ name, age, email, password_hash: hash, password_salt: salt })
        .select("id,email,name,age")
        .single();
      if (error) throw error;
      return data;
    },
    async createSession(userId, email, tokenHash, expiresAt, name, age) {
      const { error } = await client.from("paintfoot_sessions").insert({
        user_id: userId,
        token_hash: tokenHash,
        expires_at: new Date(expiresAt).toISOString(),
      });
      if (error) throw error;
      return {
        id: userId,
        email,
        name,
        age,
      };
    },
    async getSession(tokenHash) {
      const { data, error } = await client
        .from("paintfoot_sessions")
        .select("token_hash,expires_at,user_id,paintfoot_users(id,email)")
        .eq("token_hash", tokenHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async removeSession(tokenHash) {
      const { error } = await client
        .from("paintfoot_sessions")
        .delete()
        .eq("token_hash", tokenHash);
      if (error) throw error;
    },
  };
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function validateCredentials(body) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Escribe un correo electrónico válido.");
  if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const age = Number(body.age);
    if (name.length < 2 || name.length > 60) throw new Error("Escribe un nombre válido.");
    if (!Number.isInteger(age) || age < 13 || age > 120) throw new Error("La edad debe estar entre 13 y 120 años.");
    if (body.passwordConfirmation !== password) throw new Error("Las contraseñas no coinciden.");
    return { email, password, name, age };
  }
  return { email, password };
}

function createSession(store, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return store.createSession(
    user.id,
    user.email,
    tokenHash(token),
    expiresAt,
    user.name,
    user.age,
  ).then((safeUser) => ({
    accessToken: token,
    expiresAt,
    user: safeUser,
  }));
}

function startCustomAuthServer(port = Number(process.env.AUTH_PORT || DEFAULT_AUTH_PORT)) {
  const store = createAuthStore();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/auth/health") {
      return json(response, 200, { ok: Boolean(store) });
    }
    if (!store) return json(response, 503, { error: "La base de datos no está configurada en el servidor." });
    try {
      if (request.method === "POST" && ["/api/auth/register", "/api/auth/login"].includes(url.pathname)) {
        const credentials = validateCredentials(await readBody(request));
        const existing = await store.findUserByEmail(credentials.email);
        if (url.pathname.endsWith("register")) {
          if (existing) return json(response, 409, { error: "Ese correo ya tiene una cuenta. Intenta iniciar sesión." });
          const user = await store.createUser(
            credentials.name,
            credentials.age,
            credentials.email,
            credentials.password,
          );
          return json(response, 201, { session: await createSession(store, user) });
        }
        if (!existing || !verifyPassword(credentials.password, existing.password_hash, existing.password_salt)) {
          return json(response, 401, { error: "Correo o contraseña incorrectos." });
        }
        return json(response, 200, { session: await createSession(store, existing) });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token) await store.removeSession(tokenHash(token));
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: "Ruta no encontrada." });
    } catch (error) {
      console.error("[Auth] Error:", error.message);
      const validationError =
        error.message === "INVALID_JSON" ||
        error.message.includes("válido") ||
        error.message.includes("entre 13") ||
        error.message.includes("no coinciden");
      const databaseError = error.message.includes("Invalid API key")
        ? "La clave privada de Supabase no es válida. Actualiza SUPABASE_SECRET_KEY en .env y reinicia npm start."
        : error.message.includes("Could not find the table")
          ? "Falta ejecutar supabase/paintfoot-custom-auth.sql en Supabase."
          : "No fue posible completar la operación. Revisa la conexión con la base de datos.";
      return json(response, validationError ? 400 : 500, {
        error: validationError ? error.message : databaseError,
      });
    }
  });
  server.on("error", (error) => console.error("[Auth] No se pudo iniciar:", error.message));
  server.listen(port, "0.0.0.0", () => console.log(`Auth API disponible en http://localhost:${port}/api/auth`));
  return server;
}

module.exports = { startCustomAuthServer };
