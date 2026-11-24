import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';
import { useI18n } from '../i18n';

type Props = {
  currentPasswordLabel: string;
  submitLabel: string;
  autoFocus?: boolean;
  onChanged: () => void;
};

export default function PasswordChangeForm({ currentPasswordLabel, submitLabel, autoFocus = false, onChanged }: Props) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if ([...newPassword].length < 12) {
      setError(t('password.too_short'));
      return;
    }
    if (new TextEncoder().encode(newPassword).length > 1024) {
      setError(t('password.too_long'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('password.mismatch'));
      return;
    }
    if (currentPassword === newPassword) {
      setError(t('password.same'));
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onChanged();
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-stack security-password-form" onSubmit={(event) => void submit(event)}>
      <label className="field-label" htmlFor="security-current-password">{currentPasswordLabel}</label>
      <input
        id="security-current-password"
        className="text-input"
        type="password"
        autoComplete="current-password"
        autoFocus={autoFocus}
        required
        maxLength={1024}
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
      />
      <label className="field-label" htmlFor="security-new-password">{t('password.new')}</label>
      <input
        id="security-new-password"
        className="text-input"
        type="password"
        autoComplete="new-password"
        required
        maxLength={1024}
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
        aria-describedby="security-password-hint"
      />
      <small className="password-field-hint" id="security-password-hint">{t('password.hint')}</small>
      <label className="field-label" htmlFor="security-confirm-password">{t('password.confirm')}</label>
      <input
        id="security-confirm-password"
        className="text-input"
        type="password"
        autoComplete="new-password"
        required
        maxLength={1024}
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
      />
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? t('password.updating') : submitLabel}
        {!busy && <ArrowRight size={16} />}
      </button>
    </form>
  );
}
