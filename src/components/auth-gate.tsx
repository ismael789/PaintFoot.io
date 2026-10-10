import { Palette } from "@/constants/palette";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  getPersistedAuthSession,
  loginWithEmail,
  registerWithEmail,
  subscribeToAuthSession,
  type PaintFootSession,
} from "@/services/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<PaintFootSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getPersistedAuthSession().then((stored) => {
      setSession(stored);
      setChecking(false);
    });
    return subscribeToAuthSession(setSession);
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = registering
        ? await registerWithEmail(name, age, email, password, passwordConfirmation)
        : await loginWithEmail(email, password);
      setSession(result.session);
      setPassword("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "No fue posible acceder.");
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={Palette.sky400} size="large" />
      </View>
    );
  }
  if (session) return <>{children}</>;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <View style={styles.card}>
        <View style={styles.brandMark}>
          <Text style={styles.brandMarkText}>P</Text>
        </View>
        <Text style={styles.title}>PaintFoot.io</Text>
        <Text style={styles.subtitle}>
          {registering ? "Crea tu cuenta para guardar tu progreso" : "Inicia sesión para continuar"}
        </Text>
        {registering ? (
          <>
            <TextInput
              autoCapitalize="words"
              autoComplete="name"
              onChangeText={setName}
              placeholder="Nombre completo"
              placeholderTextColor={Palette.textMuted}
              style={styles.input}
              value={name}
            />
            <TextInput
              autoComplete="birthdate-year"
              keyboardType="number-pad"
              onChangeText={setAge}
              placeholder="Edad"
              placeholderTextColor={Palette.textMuted}
              style={styles.input}
              value={age}
            />
          </>
        ) : null}
        <TextInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="Correo electrónico"
          placeholderTextColor={Palette.textMuted}
          style={styles.input}
          value={email}
        />
        <TextInput
          autoCapitalize="none"
          autoComplete="password"
          onChangeText={setPassword}
          placeholder="Contraseña (mínimo 8 caracteres)"
          placeholderTextColor={Palette.textMuted}
          secureTextEntry
          style={styles.input}
          value={password}
        />
        {registering ? (
          <TextInput
            autoCapitalize="none"
            autoComplete="password"
            onChangeText={setPasswordConfirmation}
            placeholder="Repite la contraseña"
            placeholderTextColor={Palette.textMuted}
            secureTextEntry
            style={styles.input}
            value={passwordConfirmation}
          />
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable disabled={busy} onPress={() => void submit()} style={styles.primaryButton}>
          {busy ? <ActivityIndicator color={Palette.navy950} /> : <Text style={styles.primaryText}>{registering ? "Crear cuenta" : "Entrar"}</Text>}
        </Pressable>
        <Pressable disabled={busy} onPress={() => { setRegistering((value) => !value); setError(null); }} style={styles.secondaryButton}>
          <Text style={styles.secondaryText}>
            {registering ? "Ya tengo una cuenta" : "Crear una cuenta nueva"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", backgroundColor: Palette.navy950, flex: 1, justifyContent: "center" },
  screen: { alignItems: "center", backgroundColor: Palette.navy950, flex: 1, justifyContent: "center", padding: 24 },
  card: { backgroundColor: Palette.navy800, borderColor: Palette.navy700, borderRadius: 28, borderWidth: 1, maxWidth: 420, padding: 28, width: "100%" },
  brandMark: { alignItems: "center", alignSelf: "center", backgroundColor: Palette.sky400, borderRadius: 22, height: 64, justifyContent: "center", marginBottom: 16, width: 64 },
  brandMarkText: { color: Palette.navy950, fontSize: 34, fontWeight: "900" },
  title: { color: Palette.ice50, fontSize: 30, fontWeight: "900", textAlign: "center" },
  subtitle: { color: Palette.textSecondary, fontSize: 15, marginBottom: 24, marginTop: 8, textAlign: "center" },
  input: { backgroundColor: Palette.navy800, borderColor: Palette.navy700, borderRadius: 14, borderWidth: 1, color: Palette.white, fontSize: 16, marginBottom: 12, paddingHorizontal: 16, paddingVertical: 14 },
  error: { color: Palette.dangerSoft, fontSize: 14, marginBottom: 12 },
  primaryButton: { alignItems: "center", backgroundColor: Palette.sky400, borderRadius: 14, minHeight: 52, justifyContent: "center", marginTop: 4 },
  primaryText: { color: Palette.navy950, fontSize: 16, fontWeight: "900" },
  secondaryButton: { alignItems: "center", padding: 16 },
  secondaryText: { color: Palette.sky200, fontSize: 14, fontWeight: "700" },
});
