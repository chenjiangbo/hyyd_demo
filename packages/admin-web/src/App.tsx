import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { Layout } from './components/Layout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import EmployeesPage from './pages/EmployeesPage'
import EmployeeDetailPage from './pages/EmployeeDetailPage'
import OrdersPage from './pages/OrdersPage'
import OrderDetailPage from './pages/OrderDetailPage'
import MaterialsPage from './pages/MaterialsPage'
import MaterialDetailPage from './pages/MaterialDetailPage'
import MessagesPage from './pages/MessagesPage'
import CallsPage from './pages/CallsPage'
import CaptureHealthPage from './pages/CaptureHealthPage'
import UnmatchedRefsPage from './pages/UnmatchedRefsPage'
import HealthPage from './pages/HealthPage'
import SettingsPage from './pages/SettingsPage'
import CaptureDiagnosticImagesPage from './pages/CaptureDiagnosticImagesPage'
import WorkflowConfigPage from './pages/WorkflowConfigPage'
import AiScheduleConfigPage from './pages/AiScheduleConfigPage'
import SmsConfigPage from './pages/SmsConfigPage'
import OrderAiConfigPage from './pages/OrderAiConfigPage'
import SystemRemindersPage from './pages/SystemRemindersPage'
import TaikangHuanyuChannelMappingPage from './pages/TaikangHuanyuChannelMappingPage'
import OrderAiBusinessConfigPage from './pages/OrderAiBusinessConfigPage'
import AiSkillConfigPage from './pages/AiSkillConfigPage'
import TaikangFormSessionsPage from './pages/TaikangFormSessionsPage'
import TaikangFormSessionPage from './pages/TaikangFormSessionPage'
import NativeChatCollectionConfigPage from './pages/NativeChatCollectionConfigPage'
import NativeChatRecordsPage from './pages/NativeChatRecordsPage'

export default function App(): React.JSX.Element {
  const { status } = useAuth()

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center text-fg-muted">加载中…</div>
    )
  }

  if (status === 'anon') {
    return <LoginPage />
  }

  // 已登录：进主框架
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="employees/:id" element={<EmployeeDetailPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/:id" element={<OrderDetailPage />} />
        <Route path="materials" element={<MaterialsPage />} />
        <Route path="materials/:id" element={<MaterialDetailPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="calls" element={<CallsPage />} />
        <Route path="capture-health" element={<CaptureHealthPage />} />
        <Route path="capture-diagnostic-images" element={<CaptureDiagnosticImagesPage />} />
        <Route path="taikang-form-sessions" element={<TaikangFormSessionsPage />} />
        <Route path="taikang-form-sessions/:id" element={<TaikangFormSessionPage />} />
        <Route path="native-chat-collection" element={<NativeChatCollectionConfigPage />} />
        <Route path="native-chat-records" element={<NativeChatRecordsPage />} />
        <Route path="unmatched-refs" element={<UnmatchedRefsPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="workflow-config" element={<WorkflowConfigPage />} />
        <Route path="ai-schedule-config" element={<AiScheduleConfigPage />} />
        <Route path="sms-config" element={<SmsConfigPage />} />
        <Route path="order-ai-config" element={<OrderAiConfigPage />} />
        <Route path="order-ai-business-config" element={<OrderAiBusinessConfigPage />} />
        <Route path="ai-skills" element={<AiSkillConfigPage />} />
        <Route path="taikang-huanyu-channel-mappings" element={<TaikangHuanyuChannelMappingPage />} />
        <Route path="system-reminders" element={<SystemRemindersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
