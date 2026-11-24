import type { ReactNode } from 'react';
import {
  Activity, ArrowLeft, ArrowUpCircle, CircleUserRound, Cloud, FileText, Globe2,
  HardDrive, ScanFace, ShieldCheck, Users
} from 'lucide-react';
import { useI18n } from '../i18n';
import type { Lang, MessageKey } from '../i18n';
import type { DrivePanel } from '../route';
import type { SystemUpdatesStatus, TeamSummary, User } from '../types';
import AccountManagementPanel from './AccountManagementPanel';
import AccountSecurityPanel from './AccountSecurityPanel';
import DeveloperPanel from './DeveloperPanel';
import FaceManagementPanel from './FaceManagementPanel';
import GoogleDrivePanel from './GoogleDrivePanel';
import MediaIndexPanel from './MediaIndexPanel';
import NetworkDrivePanel from './NetworkDrivePanel';
import SystemUpdatePanel from './SystemUpdatePanel';
import TeamsPanel from './TeamsPanel';

type NavItem = {
  panel: Exclude<DrivePanel, null> | 'general';
  icon: ReactNode;
  label: MessageKey;
  hint: MessageKey;
};

type Props = {
  user: User;
  panel: DrivePanel;
  activeTeam: TeamSummary | null;
  updateAvailable: boolean;
  latestUpdateTag: string | null;
  onNavigate: (panel: DrivePanel) => void;
  onBack: () => void;
  onSelectWorkspace: (team: TeamSummary | null) => void;
  onUpdateStatusChange: (snapshot: SystemUpdatesStatus) => void;
};

function roleLabel(role: string): MessageKey {
  if (role === 'owner') return 'settings.role_owner';
  if (role === 'admin') return 'settings.role_admin';
  return 'settings.role_member';
}

export default function SettingsPage({
  user,
  panel,
  activeTeam,
  updateAvailable,
  latestUpdateTag,
  onNavigate,
  onBack,
  onSelectWorkspace,
  onUpdateStatusChange
}: Props) {
  const { t, lang, setLang } = useI18n();
  const isOwner = user.role === 'owner';

  const groups: { label: MessageKey; items: NavItem[] }[] = [
    {
      label: 'settings.group.general',
      items: [
        { panel: 'general', icon: <Globe2 size={17} />, label: 'settings.general', hint: 'settings.general_hint' }
      ]
    },
    {
      label: 'settings.group.account',
      items: [
        { panel: 'security', icon: <ShieldCheck size={17} />, label: 'menu.account_security', hint: 'settings.security_hint' },
        { panel: 'network-drive', icon: <HardDrive size={17} />, label: 'menu.network_drive', hint: 'settings.network_hint' }
      ]
    },
    {
      label: 'settings.group.workspace',
      items: [
        { panel: 'teams', icon: <Users size={17} />, label: 'nav.teams', hint: 'settings.teams_hint' },
        { panel: 'google-drive', icon: <Cloud size={17} />, label: 'nav.google_drive', hint: 'settings.google_hint' }
      ]
    },
    ...(isOwner ? [{
      label: 'settings.group.admin' as const,
      items: [
        { panel: 'accounts' as const, icon: <Users size={17} />, label: 'menu.manage_accounts' as const, hint: 'settings.accounts_hint' as const },
        { panel: 'faces' as const, icon: <ScanFace size={17} />, label: 'drive.face_groups' as const, hint: 'settings.faces_hint' as const },
        { panel: 'indexing' as const, icon: <Activity size={17} />, label: 'drive.media_indexing' as const, hint: 'settings.indexing_hint' as const },
        { panel: 'updates' as const, icon: <ArrowUpCircle size={17} />, label: 'menu.system_updates' as const, hint: 'settings.updates_hint' as const }
      ]
    }] : []),
    {
      label: 'settings.group.advanced',
      items: [
        { panel: 'developer', icon: <FileText size={17} />, label: 'menu.developer', hint: 'settings.developer_hint' }
      ]
    }
  ];

  const active = panel ?? 'general';

  function content() {
    const back = () => onNavigate(null);
    switch (panel) {
      case 'accounts':
        return isOwner ? <AccountManagementPanel user={user} onClose={back} /> : null;
      case 'faces':
        return isOwner ? <FaceManagementPanel onClose={back} /> : null;
      case 'indexing':
        return isOwner ? <MediaIndexPanel onClose={back} /> : null;
      case 'updates':
        return isOwner ? <SystemUpdatePanel onClose={back} onStatusChange={onUpdateStatusChange} /> : null;
      case 'teams':
        return <TeamsPanel user={user} activeTeamId={activeTeam?.id ?? null} onSelectWorkspace={onSelectWorkspace} onClose={back} />;
      case 'google-drive':
        return <GoogleDrivePanel isOwner={isOwner} onClose={back} />;
      case 'security':
        return <AccountSecurityPanel user={user} onClose={back} />;
      case 'developer':
        return <DeveloperPanel user={user} onClose={back} />;
      case 'network-drive':
        return <NetworkDrivePanel email={user.email} onClose={back} onOpenDeveloper={() => onNavigate('developer')} />;
      default:
        return (
          <div className="settings-general">
            <section className="security-card settings-general-card" aria-labelledby="settings-language-title">
              <div className="security-card-heading">
                <span className="security-card-icon"><Globe2 size={16} /></span>
                <div>
                  <h3 id="settings-language-title">{t('settings.language')}</h3>
                  <p>{t('settings.language_hint')}</p>
                </div>
              </div>
              <div className="settings-language-options" role="radiogroup" aria-label={t('settings.language')}>
                {(['en', 'vi'] as Lang[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={lang === option}
                    className={'settings-language-option' + (lang === option ? ' is-active' : '')}
                    onClick={() => setLang(option)}
                  >
                    <strong>{option === 'en' ? 'English' : 'Tiếng Việt'}</strong>
                    <small>{option === 'en' ? 'English (US)' : 'Việt Nam'}</small>
                  </button>
                ))}
              </div>
            </section>

            <section className="security-card settings-general-card" aria-labelledby="settings-account-title">
              <div className="security-card-heading">
                <span className="security-card-icon"><CircleUserRound size={16} /></span>
                <div>
                  <h3 id="settings-account-title">{t('settings.account_card')}</h3>
                  <p>{t('settings.signed_in', { email: user.email })}</p>
                </div>
              </div>
              <div className="settings-account-row">
                <span className="settings-role-badge">{t(roleLabel(user.role))}</span>
                <button className="button button-secondary" type="button" onClick={() => onNavigate('security')}>
                  <ShieldCheck size={15} /> {t('menu.account_security')}
                </button>
              </div>
            </section>
          </div>
        );
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label={t('settings.title')}>
        <button className="settings-back" type="button" onClick={onBack}>
          <ArrowLeft size={16} /> {t('settings.back')}
        </button>
        {groups.map((group) => (
          <div className="settings-nav-group" key={group.label}>
            <div className="nav-section-label">{t(group.label)}</div>
            {group.items.map((item) => (
              <button
                key={item.panel}
                className={'nav-item settings-nav-item' + (active === item.panel ? ' active' : '')}
                onClick={() => onNavigate(item.panel === 'general' ? null : item.panel)}
                aria-current={active === item.panel ? 'page' : undefined}
              >
                {item.icon}
                <span className="settings-nav-copy">
                  <span>{t(item.label)}</span>
                  <small>{t(item.hint)}</small>
                </span>
                {item.panel === 'updates' && updateAvailable ? (
                  <span className="update-menu-badge settings-update-badge">{latestUpdateTag || t('menu.update_new')}</span>
                ) : null}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div className="settings-content">{content()}</div>
    </div>
  );
}
