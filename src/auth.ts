import { type Session } from '@supabase/supabase-js';
import { requireSupabase } from './supabase';

export type Account = {
  id: string;
  username: string;
};

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const AUTH_EMAIL_DOMAIN = 'users.fittrack.app';

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateCredentials(username: string, password: string): string | null {
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    return 'El usuario debe tener entre 3 y 20 caracteres y usar solo letras, numeros, guion o guion bajo.';
  }
  if (password.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres.';
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'La contraseña debe incluir al menos una letra y un numero.';
  }
  return null;
}

function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@${AUTH_EMAIL_DOMAIN}`;
}

function accountFromSession(session: Session | null): Account | null {
  if (!session?.user) {
    return null;
  }

  const username = session.user.user_metadata?.username;
  if (typeof username !== 'string' || !username) {
    return null;
  }

  return { id: session.user.id, username };
}

function friendlyAuthError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) {
    return 'Usuario o contraseña incorrectos.';
  }
  if (normalized.includes('already registered') || normalized.includes('already been registered')) {
    return 'Ese nombre de usuario ya esta en uso.';
  }
  if (normalized.includes('rate limit')) {
    return 'Demasiados intentos. Espera unos minutos y volve a probar.';
  }
  return message;
}

export async function getCurrentAccount(): Promise<Account | null> {
  const client = requireSupabase();
  const { data, error } = await client.auth.getSession();
  if (error) {
    throw new Error(friendlyAuthError(error.message));
  }
  return accountFromSession(data.session);
}

export function subscribeToAccount(onChange: (account: Account | null) => void) {
  const client = requireSupabase();
  return client.auth.onAuthStateChange((_event, session) => onChange(accountFromSession(session))).data.subscription;
}

export async function registerWithUsername(username: string, password: string): Promise<Account> {
  const validationError = validateCredentials(username, password);
  if (validationError) {
    throw new Error(validationError);
  }

  const client = requireSupabase();
  const normalized = normalizeUsername(username);
  const { data, error } = await client.auth.signUp({
    email: usernameToEmail(normalized),
    password,
    options: { data: { username: normalized } },
  });

  if (error) {
    throw new Error(friendlyAuthError(error.message));
  }
  const account = accountFromSession(data.session);
  if (!account) {
    throw new Error('Desactiva la confirmacion de email en Supabase Auth para usar el registro por usuario.');
  }
  return account;
}

export async function loginWithUsername(username: string, password: string): Promise<Account> {
  const validationError = validateCredentials(username, password);
  if (validationError) {
    throw new Error(validationError);
  }

  const client = requireSupabase();
  const { data, error } = await client.auth.signInWithPassword({
    email: usernameToEmail(username),
    password,
  });
  if (error) {
    throw new Error(friendlyAuthError(error.message));
  }

  const account = accountFromSession(data.session);
  if (!account) {
    throw new Error('No pudimos iniciar la sesion.');
  }
  return account;
}

export async function logout(): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.auth.signOut();
  if (error) {
    throw new Error(friendlyAuthError(error.message));
  }
}
