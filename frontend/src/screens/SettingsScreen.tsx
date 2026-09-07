import { Link } from 'react-router-dom';
import { screens, type ScreenDefinition } from '../routes/catalog';
import { canOpenScreen, useAccess } from '../hooks/useWorkspaceAccess';
import './role-settings.css';

export function SettingsScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const access = useAccess();
  const targets = ['/settings/ai-key', '/settings/roles', '/settings/organization', '/settings/branches'];
  const links = screens.filter(item => targets.includes(item.path) && access && canOpenScreen(access, item));
  const reservation = screens.find(item => item.path === '/reserve');
  const managesReservations = access && reservation && canOpenScreen(access, reservation)
    && (access.permissions.includes('*') || access.permissions.includes('reservation.manage'));
  return <section className="screen role-settings">
    <header><h1>{screen.label}</h1><p>조직의 기능 사용 여부와 구성원의 역할 권한은 별도로 관리합니다.</p></header>
    <div className="settings-links">{links.map(item => <Link key={item.path} to={item.path}><strong>{item.label}</strong><span>{item.description}</span></Link>)}
      {managesReservations && <Link to="/reserve?tab=admin"><strong>예약 공간 관리</strong><span>선택한 회사의 공간과 예약 운영 설정을 관리합니다.</span></Link>}
    </div>
    {!links.length && !managesReservations && <p role="status">접근 가능한 설정 항목이 없습니다.</p>}
  </section>;
}
