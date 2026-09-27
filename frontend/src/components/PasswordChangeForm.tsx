import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../format';

type Props = {
  currentPasswordLabel: string;
  submitLabel: string;
  autoFocus?: boolean;
  onChanged: () => void;
};

export default function PasswordChangeForm({ currentPasswordLabel, submitLabel, autoFocus = false, onChanged }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if ([...newPassword].length < 12) {
      setError('Choose a password with at least 12 characters.');
      return;
    }
    if (new TextEncoder().encode(newPassword).length > 1024) {
      setError('The new password must be no more than 1,024 bytes.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (currentPassword === newPassword) {
      setError('Choose a password different from your current password.');
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
      <label className="field-label" htmlFor="security-new-password">New password</label>
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
      <small className="password-field-hint" id="security-password-hint">Use at least 12 characters.</small>
      <label className="field-label" htmlFor="security-confirm-password">Confirm new password</label>
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
        {busy ? 'Updating password…' : submitLabel}
        {!busy && <ArrowRight size={16} />}
      </button>
    </form>
  );
}
