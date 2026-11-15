import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  FolderOpen,
  HardDrive,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { api } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import type { ManagedAccount, TeamDetail, TeamMemberSummary, TeamSummary, User } from '../types';

type Props = {
  user: User;
  activeTeamId: string | null;
  onSelectWorkspace: (team: TeamSummary | null) => void;
  onClose: () => void;
};

const GIB = 1024 ** 3;
const MAX_QUOTA_GB = 8_000_000_000_000_000 / GIB;

function quotaInGb(bytes: number): string {
  return (bytes / GIB).toFixed(2).replace(/\.00$/, '');
}

function quotaBytes(gigabytes: number): number {
  return Math.round(gigabytes * GIB);
}

function teamUsagePercent(team: TeamSummary): number {
  if (team.quotaBytes <= 0) return team.usedBytes + team.reservedBytes > 0 ? 100 : 0;
  return Math.min(100, ((team.usedBytes + team.reservedBytes) / team.quotaBytes) * 100);
}

export default function TeamsPanel({ user, activeTeamId, onSelectWorkspace, onClose }: Props) {
  const isOwner = user.role === 'owner';
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(activeTeamId);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [knownAccounts, setKnownAccounts] = useState<ManagedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newQuotaGb, setNewQuotaGb] = useState('25');

  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editQuotaGb, setEditQuotaGb] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'member' | 'admin'>('member');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      api.listTeams(controller.signal),
      isOwner ? api.managedAccounts(0, controller.signal).catch(() => null) : Promise.resolve(null),
    ])
      .then(([teamRes, accountsRes]) => {
        setTeams(teamRes.teams);
        if (accountsRes) {
          setKnownAccounts(accountsRes.accounts);
        }
        setSelectedTeamId((current) => {
          if (current && teamRes.teams.some((t) => t.id === current)) return current;
          if (activeTeamId && teamRes.teams.some((t) => t.id === activeTeamId)) return activeTeamId;
          return teamRes.teams[0]?.id ?? null;
        });
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(friendlyError(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, isOwner, activeTeamId]);

  useEffect(() => {
    if (!selectedTeamId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setLoadingDetail(true);
    api
      .getTeam(selectedTeamId, controller.signal)
      .then((res) => {
        setDetail(res);
        setEditName(res.team.name);
        setEditDesc(res.team.description);
        setEditQuotaGb(quotaInGb(res.team.quotaBytes));
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(friendlyError(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });
    return () => controller.abort();
  }, [selectedTeamId, refreshKey]);

  async function handleCreateTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = newName.trim();
    const gb = Number(newQuotaGb);
    if (!trimmedName || !Number.isFinite(gb) || gb < 0 || gb > MAX_QUOTA_GB) {
      setError('Enter a team name and a storage quota between 0 GB and 7,450,580 GB.');
      return;
    }
    setBusyKey('create-team');
    setError('');
    setNotice('');
    try {
      const created = await api.createTeam({
        name: trimmedName,
        description: newDesc.trim(),
        quotaBytes: quotaBytes(gb),
      });
      setNewName('');
      setNewDesc('');
      setNewQuotaGb('25');
      setSelectedTeamId(created.id);
      setRefreshKey((value) => value + 1);
      setNotice(`Team "${created.name}" created with a shared workspace.`);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSaveTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const trimmedName = editName.trim();
    const gb = Number(editQuotaGb);
    if (!trimmedName) {
      setError('Team name cannot be empty.');
      return;
    }
    if (isOwner && (!Number.isFinite(gb) || gb < 0 || gb > MAX_QUOTA_GB)) {
      setError('Enter a valid storage quota.');
      return;
    }
    setBusyKey('save-team');
    setError('');
    setNotice('');
    try {
      const updated = await api.updateTeam(detail.team.id, {
        name: trimmedName,
        description: editDesc.trim(),
        ...(isOwner ? { quotaBytes: quotaBytes(gb) } : {}),
      });
      setTeams((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setDetail((prev) => (prev ? { ...prev, team: updated } : prev));
      setNotice(`Team "${updated.name}" settings saved.`);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteTeam(team: TeamSummary) {
    if (
      !window.confirm(
        `Delete team "${team.name}"? All folders inside it must be empty of files first.`
      )
    ) {
      return;
    }
    setBusyKey('delete-team');
    setError('');
    setNotice('');
    try {
      await api.deleteTeam(team.id);
      if (activeTeamId === team.id) {
        onSelectWorkspace(null);
      }
      setSelectedTeamId(null);
      setDetail(null);
      setRefreshKey((value) => value + 1);
      setNotice(`Team "${team.name}" deleted.`);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAddMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const trimmedEmail = memberEmail.trim().toLowerCase();
    if (!trimmedEmail) {
      setError('Enter the email address of an existing account.');
      return;
    }
    setBusyKey('add-member');
    setError('');
    setNotice('');
    try {
      const added = await api.addTeamMember(detail.team.id, {
        email: trimmedEmail,
        role: memberRole,
      });
      setMemberEmail('');
      setMemberRole('member');
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              team: { ...prev.team, memberCount: prev.team.memberCount + 1 },
              members: [...prev.members, added],
            }
          : prev
      );
      setRefreshKey((value) => value + 1);
      setNotice(`${added.email} added to "${detail.team.name}".`);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleChangeMemberRole(member: TeamMemberSummary, nextRole: 'admin' | 'member') {
    if (!detail || member.role === nextRole) return;
    setBusyKey('role:' + member.userId);
    setError('');
    setNotice('');
    try {
      await api.updateTeamMember(detail.team.id, member.userId, nextRole);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              members: prev.members.map((m) =>
                m.userId === member.userId ? { ...m, role: nextRole } : m
              ),
            }
          : prev
      );
      setNotice(`Updated ${member.email} to ${nextRole}.`);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRemoveMember(member: TeamMemberSummary) {
    if (!detail) return;
    const isSelf = member.userId === user.id;
    const prompt = isSelf
      ? `Leave team "${detail.team.name}"?`
      : `Remove ${member.email} from team "${detail.team.name}"?`;
    if (!window.confirm(prompt)) return;
    setBusyKey('remove:' + member.userId);
    setError('');
    setNotice('');
    try {
      await api.removeTeamMember(detail.team.id, member.userId);
      if (isSelf && activeTeamId === detail.team.id && !isOwner) {
        onSelectWorkspace(null);
      }
      setRefreshKey((value) => value + 1);
      setNotice(isSelf ? `Left team "${detail.team.name}".` : `Removed ${member.email}.`);
    } catch (cause: unknown) {
      setError(friendlyError(cause));
    } finally {
      setBusyKey(null);
    }
  }

  const canManageSelectedTeam =
    detail != null && (isOwner || detail.team.myRole === 'admin' || detail.team.myRole === 'owner');
  const existingMemberIds = new Set(detail?.members.map((m) => m.userId) ?? []);
  const addableKnownAccounts = knownAccounts.filter(
    (acct) => !acct.disabledAt && !existingMemberIds.has(acct.id)
  );

  return (
    <section className="account-admin-panel" id="teams-admin-panel" aria-labelledby="teams-panel-title">
      <div className="account-admin-header">
        <div>
          <span className="eyebrow">SHARED WORKSPACES</span>
          <h2 id="teams-panel-title">Teams & shared drives</h2>
          <p>
            Create shared team workspaces with pooled storage quotas and team-level admin/member permissions.
          </p>
        </div>
        <div className="account-admin-header-actions">
          {activeTeamId ? (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                onSelectWorkspace(null);
                onClose();
              }}
            >
              <HardDrive size={15} /> Back to My Drive
            </button>
          ) : null}
          <button
            className="icon-button account-refresh"
            type="button"
            aria-label="Refresh teams"
            disabled={loading || busyKey !== null}
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
          <button className="icon-button" type="button" aria-label="Close teams" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </div>

      {isOwner ? (
        <form className="account-create-form" onSubmit={(event) => void handleCreateTeam(event)}>
          <div className="account-create-intro">
            <span className="account-create-icon"><Users size={17} /></span>
            <span>
              <strong>New team</strong>
              <small>Includes a shared drive and quota.</small>
            </span>
          </div>
          <label className="account-form-field account-email-field">
            <span>Team name</span>
            <input
              className="text-input"
              type="text"
              maxLength={80}
              required
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Design & Media"
            />
          </label>
          <label className="account-form-field account-quota-field">
            <span>Team quota <small>GB</small></span>
            <input
              className="text-input"
              type="number"
              min="0"
              max={MAX_QUOTA_GB}
              step="0.01"
              required
              value={newQuotaGb}
              onChange={(event) => setNewQuotaGb(event.target.value)}
            />
          </label>
          <label className="account-form-field team-desc-field">
            <span>Description <small>optional</small></span>
            <input
              className="text-input"
              type="text"
              maxLength={500}
              value={newDesc}
              onChange={(event) => setNewDesc(event.target.value)}
              placeholder="Shared assets, project folders, and deliverables"
            />
          </label>
          <button className="button button-primary account-create-button" type="submit" disabled={busyKey !== null}>
            <Plus size={16} />{busyKey === 'create-team' ? 'Creating…' : 'Create team'}
          </button>
        </form>
      ) : null}

      {error ? <div className="account-admin-message account-admin-error" role="alert">{error}</div> : null}
      {notice && !error ? <div className="account-admin-message account-admin-notice" role="status">{notice}</div> : null}

      {loading ? (
        <div className="account-admin-loading"><span className="spinner" />Loading teams…</div>
      ) : teams.length === 0 ? (
        <div className="account-admin-empty">
          <Users size={19} />
          <span>
            {isOwner
              ? 'No teams yet. Create your first team above to collaborate in a shared drive.'
              : 'You have not been added to any team workspaces yet.'}
          </span>
        </div>
      ) : (
        <div className="teams-workspace-grid">
          <div className="account-list">
            {teams.map((team) => {
              const selected = selectedTeamId === team.id;
              const isCurrentWorkspace = activeTeamId === team.id;
              const totalUsed = team.usedBytes + team.reservedBytes;
              return (
                <article
                  key={team.id}
                  className={'account-card' + (selected ? ' team-card-selected' : '')}
                  onClick={() => setSelectedTeamId(team.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="account-card-identity">
                    <div className="account-card-avatar"><Users size={17} /></div>
                    <div className="account-card-name">
                      <strong title={team.name}>{team.name}</strong>
                      <span>{team.memberCount} member{team.memberCount === 1 ? '' : 's'} · Role: {team.myRole}</span>
                    </div>
                    <span className="account-status"><i />{team.myRole}</span>
                  </div>

                  {team.description ? <p className="team-card-desc">{team.description}</p> : null}

                  <div className="account-card-storage">
                    <div className="account-storage-label">
                      <span>Team storage</span>
                      <strong>{formatSize(totalUsed)} <small>of {formatSize(team.quotaBytes)}</small></strong>
                    </div>
                    <div className="account-storage-track">
                      <i style={{ width: teamUsagePercent(team) + '%' }} />
                    </div>
                    <small>{formatSize(team.usedBytes)} stored · {formatSize(team.reservedBytes)} uploading</small>
                  </div>

                  <div className="account-access-actions">
                    <button
                      type="button"
                      className={isCurrentWorkspace ? 'button button-primary' : 'button button-secondary'}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectWorkspace(isCurrentWorkspace ? null : team);
                        onClose();
                      }}
                    >
                      {isCurrentWorkspace ? <><Check size={14} /> Active workspace</> : <><FolderOpen size={14} /> Open shared drive</>}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {selectedTeamId ? (
            <div className="team-detail-card account-card">
              {loadingDetail || !detail ? (
                <div className="account-admin-loading"><span className="spinner" />Loading team details…</div>
              ) : (
                <>
                  <div className="account-card-identity">
                    <div className="account-card-avatar"><Shield size={17} /></div>
                    <div className="account-card-name">
                      <strong>{detail.team.name}</strong>
                      <span>Created {formatDate(detail.team.createdAt)} · Slug {detail.team.slug}</span>
                    </div>
                    {isOwner ? (
                      <button
                        type="button"
                        className="button button-quiet-danger"
                        disabled={busyKey !== null}
                        onClick={() => void handleDeleteTeam(detail.team)}
                      >
                        <Trash2 size={14} /> Delete team
                      </button>
                    ) : null}
                  </div>

                  {canManageSelectedTeam ? (
                    <form className="team-settings-form" onSubmit={(event) => void handleSaveTeam(event)}>
                      <label className="account-form-field">
                        <span>Team name</span>
                        <input
                          className="text-input"
                          type="text"
                          maxLength={80}
                          required
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                        />
                      </label>
                      <label className="account-form-field">
                        <span>Description</span>
                        <input
                          className="text-input"
                          type="text"
                          maxLength={500}
                          value={editDesc}
                          onChange={(event) => setEditDesc(event.target.value)}
                        />
                      </label>
                      {isOwner ? (
                        <label className="account-form-field">
                          <span>Storage quota <small>GB</small></span>
                          <input
                            className="text-input"
                            type="number"
                            min="0"
                            max={MAX_QUOTA_GB}
                            step="0.01"
                            required
                            value={editQuotaGb}
                            onChange={(event) => setEditQuotaGb(event.target.value)}
                          />
                        </label>
                      ) : null}
                      <button className="button button-secondary" type="submit" disabled={busyKey !== null}>
                        {busyKey === 'save-team' ? 'Saving…' : 'Save team settings'}
                      </button>
                    </form>
                  ) : null}

                  <div className="team-members-section">
                    <div className="account-admin-list-heading">
                      <div><Users size={15} /><strong>Members</strong><span>{detail.members.length}</span></div>
                    </div>

                    {canManageSelectedTeam ? (
                      <form className="team-add-member-form" onSubmit={(event) => void handleAddMember(event)}>
                        <input
                          className="text-input"
                          type="email"
                          list="team-known-accounts"
                          placeholder="user@example.com"
                          value={memberEmail}
                          onChange={(event) => setMemberEmail(event.target.value)}
                        />
                        {addableKnownAccounts.length > 0 ? (
                          <datalist id="team-known-accounts">
                            {addableKnownAccounts.map((acct) => (
                              <option key={acct.id} value={acct.email} />
                            ))}
                          </datalist>
                        ) : null}
                        <select
                          className="text-input"
                          value={memberRole}
                          onChange={(event) => setMemberRole(event.target.value === 'admin' ? 'admin' : 'member')}
                          aria-label="Member team role"
                        >
                          <option value="member">Member</option>
                          <option value="admin">Team Admin</option>
                        </select>
                        <button className="button button-primary" type="submit" disabled={busyKey !== null}>
                          <UserPlus size={14} /> Add
                        </button>
                      </form>
                    ) : null}

                    <div className="team-member-list">
                      {detail.members.map((member) => (
                        <div className="team-member-row" key={member.userId}>
                          <div className="team-member-info">
                            <strong>{member.email}</strong>
                            <small>
                              Account role: {member.accountRole}
                              {member.disabledAt ? ' · Disabled' : ''}
                            </small>
                          </div>
                          <div className="team-member-controls">
                            {canManageSelectedTeam ? (
                              <select
                                className="text-input team-role-select"
                                value={member.role}
                                disabled={busyKey !== null}
                                onChange={(event) =>
                                  void handleChangeMemberRole(
                                    member,
                                    event.target.value === 'admin' ? 'admin' : 'member'
                                  )
                                }
                                aria-label={`Team role for ${member.email}`}
                              >
                                <option value="member">Member</option>
                                <option value="admin">Team Admin</option>
                              </select>
                            ) : (
                              <span className="account-status"><i />{member.role}</span>
                            )}
                            {canManageSelectedTeam || member.userId === user.id ? (
                              <button
                                type="button"
                                className="button button-quiet-danger"
                                disabled={busyKey !== null}
                                onClick={() => void handleRemoveMember(member)}
                              >
                                <UserMinus size={14} /> {member.userId === user.id ? 'Leave' : 'Remove'}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
