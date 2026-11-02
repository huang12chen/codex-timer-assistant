// Only application-owned messages are translated. User-provided titles, chat
// names, paths, and message contents must never be passed through this catalog.
const en = Object.freeze({
  'Codex 定时助手':'Codex Timer Assistant','Codex 倒计时':'Codex Timer','定时助手':'Timer Assistant','主导航':'Main navigation',
  '任务计划':'Tasks','执行记录':'History','连接与设置':'Settings','本机运行':'Running locally',
  '显示倒计时悬浮球':'Show floating timer','显示悬浮球':'Show floating timer','隐藏悬浮球':'Hide floating timer','悬浮球':'Timer',
  '最小化':'Minimize','展开或还原窗口':'Expand or restore','关闭到托盘':'Close to tray','关闭':'Close',
  '自动调度已停止':'Scheduler stopped','检查并恢复调度':'Check and resume','刷新官方额度，每 15 秒自动同步':'Refresh usage; updates automatically every 15 seconds',
  '刷新额度':'Refresh usage','新建任务':'New task','查看连接与设置':'Open settings','正在检查连接':'Checking connection',
  '连接本机 Codex':'Connecting to Codex','已连接本机 Codex':'Connected to Codex','连接需要检查':'Connection needs attention',
  '额度剩余':'Usage limit','5 小时剩余':'5-hour limit','本周剩余':'Weekly limit','等待同步':'Waiting for sync',
  '等待官方更新':'Waiting for update','未提供额度信息':'Not provided','同步中':'Syncing','额度同步失败':'Usage sync failed','等待额度同步':'Waiting for usage',
  '下一次执行':'Next run','已安排':'Scheduled','筛选任务':'Filter tasks','全部任务':'All tasks','已启用':'Enabled','需要处理':'Needs attention',
  '包含已启用的等待发送、等待额度及看守任务':'Includes scheduled, quota-waiting and watching tasks',
  '暂停全部':'Pause all','恢复全部':'Resume all','添加第一个任务':'Add your first task','选择聊天，设置发送时间或看守规则。':'Choose a chat and schedule a message or watch.',
  '添加当前聊天':'Add current chat','选择指定聊天':'Choose a chat','选择聊天':'Choose a chat','查看全部任务':'View all tasks',
  '旧任务使用当前页面；保存修改前，请选择固定聊天。取消不会改变原任务。':'This older task follows the current page. Choose a specific chat before saving. Cancel to leave the task unchanged.',
  '任务已删除':'Task deleted',
  '待确认':'Unconfirmed','确认已送达':'Confirm delivered','确认已送达？':'Confirm delivery?',
  '请确认对应聊天中已收到这条消息。确认后不会重发，任务将停止。':'Confirm only if the message appears in the target chat. The task will stop and the message will not be resent.',
  '本人确认消息已送达':'Delivery confirmed by you.','本人确认消息已送达；看守保持暂停':'Delivery confirmed by you. Watching remains paused.',
  '待核实的发送记录已变化，请重新检查任务':'The unconfirmed send has changed. Check the task again.','操作标识无效':'Invalid action ID.',
  '目标聊天出现新的运行状态，定时消息已确认送达':'The scheduled message was confirmed delivered to the target chat.',
  '正在查找本机聊天…':'Finding local chats…','请先选择本机聊天或粘贴深度链接。':'Choose a local chat or paste a chat link first.',
  '导出记录':'Export history','清空记录':'Clear history','记录筛选':'Filter history','全部':'All','需留意':'Attention',
  '时间与任务':'Time and task','执行结果':'Result','显示更多':'Show more','检查连接':'Check connection',
  'Codex 连接':'Codex connection','正在检查本机安装与登录状态。':'Checking the local installation and sign-in.',
  '连接详情':'Connection details','Codex CLI 路径':'Codex CLI path','自动发现':'Automatic','选择 Codex 程序':'Choose Codex executable',
  '运行偏好':'Preferences','界面语言':'Language','跟随系统':'System default','简体中文':'Simplified Chinese',
  '倒计时悬浮球':'Floating timer','在桌面显示，可拖动位置':'Show on the desktop; drag to move',
  '任务期间防止休眠':'Keep computer awake','有启用任务时保持电脑唤醒':'Stay awake while tasks are enabled',
  '玻璃透明度':'Glass transparency','调高可透出更多背景，调低让文字更清晰。':'Increase to show more background; decrease for clearer text.',
  '计划时区':'Time zone','大西洋时间 · Halifax':'Atlantic time · Halifax','中国标准时间 · Shanghai':'China time · Shanghai',
  '美国东部时间 · New York':'Eastern time · New York','美国太平洋时间 · Los Angeles':'Pacific time · Los Angeles',
  '英国时间 · London':'UK time · London','协调世界时 · UTC':'Coordinated Universal Time · UTC',
  '运行说明':'How it works','关闭窗口后，助手留在托盘运行。请保持电脑开机且未锁屏；退出助手会停止后续调度，已经运行的 Codex 任务不会被中断。':'Closing the window keeps the assistant in the tray. Keep the computer awake and unlocked. Quitting stops future schedules but does not interrupt a running Codex task.',
  '额度恢复时先检查聊天是否仍在工作。权限请求、无法识别的选择、发送结果不确定的操作会标记为“需要处理”。':'The assistant checks the chat before continuing. Approvals, unsupported choices, and uncertain sends require your attention.',
  '暂停全部任务':'Pause all tasks','数据保存在本机':'Data stays on this computer','删除任务？':'Delete task?',
  '执行记录会保留。':'Execution history will be kept.','取消':'Cancel','删除':'Delete','定时发送':'Scheduled message',
  '持续看守':'Watch','确认消息送达后，此定时任务结束。':'This task ends when the message is confirmed delivered.',
  '任务名称':'Task name','例如：今晚完善项目':'For example: Finish the project tonight','目标聊天':'Target chat','当前页面':'Current page','固定聊天':'Specific chat',
  '选择 Codex 窗口':'Choose a Codex window','正在查找 Codex 窗口…':'Finding Codex windows…','读取当前聊天':'Read current chat',
  '执行时跟随所选窗口的当前聊天。读取会短暂使用剪贴板。':'Uses the selected window’s current chat at execution time. Reading briefly uses the clipboard.',
  '粘贴 Codex 聊天深度链接':'Paste a Codex chat link','聊天深度链接':'Chat link','粘贴':'Paste',
  '在 Codex 聊天菜单中选择“复制 → 复制深度链接”。':'In Codex, open the chat menu and choose Copy → Copy deep link.',
  '从本机聊天中选择':'Choose a local chat','搜索聊天名称':'Search chats','搜索聊天':'Search chats','打开聊天核对':'Open chat',
  '执行时间':'Send at','结束看守时间':'Stop watching at','使用额度刷新时间':'Use usage reset time','延后1分钟':'Add 1 minute',
  '到点核对额度，尚未恢复会继续等待。':'Usage is checked at the scheduled time; if unavailable, the task waits.',
  '发送内容':'Message','继续完成本聊天已经确认的任务。':'Continue the tasks already agreed in this chat.',
  '根据本聊天已经确认的目标、约束和验收标准，自行比较并选择最合适的方案，简要记录理由后继续执行。普通实现选择无需再次询问我；完成约定目标后停止。':'Within the goals and constraints already agreed in this chat, choose a suitable approach, briefly explain the choice, and continue. Do not ask again about ordinary implementation choices; stop when the agreed goal is complete.',
  '任务图片':'Task images','图片':'Images','添加图片':'Add images','可拖入或粘贴 PNG、JPEG、WebP；每张10 MiB，合计32 MiB。':'Drag or paste PNG, JPEG or WebP; 10 MiB each, 32 MiB total.',
  '自动回复普通方案选择':'Answer ordinary choices automatically','仅处理可以明确识别的普通问题。':'Only clearly identified ordinary choices.',
  '选择题回复模板':'Choice reply template','不限看守时长，直到目标完成或手动停止':'Watch until the goal is complete or manually stopped',
  '保存后启用任务':'Enable task after saving','保存任务':'Save task','保存修改':'Save changes','创建并启用':'Create and enable',
  '移除':'Remove','正在导入图片…':'Importing images…','图片正在处理，请稍候。':'Images are still processing. Please wait.',
  '图片正在处理，请稍候再保存。':'Wait for the images to finish processing before saving.',
  '每项任务最多添加8张图片。':'Each task supports up to 8 images.','只支持 PNG、JPEG、WebP 图片。':'Only PNG, JPEG and WebP images are supported.',
  '每张图片须大于0且不超过10 MiB。':'Each image must be between 1 byte and 10 MiB.','图片总大小不能超过32 MiB。':'Images must total no more than 32 MiB.',
  '图片已移除，草稿副本暂未清理；关闭编辑器时会重试。':'Image removed; draft cleanup will be retried when the editor closes.',
  '任务编辑已结束，但图片草稿暂未清理；下次启动会重试。':'Editing ended; image draft cleanup will be retried on startup.',
  '调度器未运行，请检查后恢复。':'The scheduler is not running. Check it and resume.',
  '界面测试：使用独立测试数据，不向真实聊天发送消息。':'UI test: isolated data; no real messages are sent.',
  '点击重新检查连接，确认本机支持的能力。':'Check the connection to see which features are available.',
  '尚未发现 Codex CLI':'Codex CLI not found','读取聊天列表':'Read chat list','读取额度时间':'Read usage reset','识别任务状态':'Read task status',
  '发送消息':'Send messages','读取当前页面':'Read current page','回复普通选择':'Answer ordinary choices','可用':'Available','未启用':'Unavailable',
  '还没有启用的任务':'No enabled tasks','没有需要处理的任务':'Nothing needs attention',
  '在全部任务中点击播放按钮，即可启用。':'Use the play button under All tasks to enable one.','可以回到全部任务查看计划。':'Return to All tasks to see your plans.',
  '已绑定聊天':'Selected chat','定位聊天':'Open chat','编辑任务':'Edit task','暂停任务':'Pause task','启用任务':'Enable task','删除任务':'Delete task',
  '这项任务已经移除。':'This task has already been removed.','调度已停止，需要处理':'Scheduler stopped','自动调度尚未运行。':'The scheduler is not running.',
  '已停止':'Stopped','请检查并恢复调度':'Check and resume the scheduler','后续自动操作已停止':'Future automatic actions are stopped',
  '全部任务已暂停':'All tasks are paused','你的下一项计划':'Your next task','恢复后，助手会先核对目标与任务状态。':'The target and task state are checked before resuming.',
  '选择聊天，设好时间，剩下的交给助手。':'Choose a chat and set a time.','已暂停':'Paused','等待安排':'Waiting',
  '尚无待执行计划':'No scheduled tasks','后续自动操作已暂停':'Future automatic actions are paused','准备就绪，等待添加任务':'Ready for a task',
  '跟随所选窗口的当前聊天':'Current chat in the selected window','已绑定指定聊天':'Specific chat','核对中':'Checking',
  '持续观察任务状态':'Watching the task','距下次额度核对':'Until next usage check','距下次重试':'Until retry','距开始执行':'Until start','当前任务':'Current task',
  '结束看守':'watch ends','暂时没有可用的官方刷新时间，可以手动选择时间':'No reset time is available. Set a time manually.',
  '当前版本尚未支持自动填写选择题，遇到时会暂停并提醒。':'Automatic answers to already-open choices are not supported. The task will pause for you.',
  '仅处理明确识别的普通方案选择，权限请求仍等待你处理。':'Only clearly identified ordinary choices; approvals still require you.',
  '已删除的任务':'Deleted task','助手':'Assistant','没有需要留意的记录。':'No records need attention.',
  '还没有执行记录。安排任务后，检查和操作会显示在这里。':'No history yet. Task checks and actions will appear here.',
  '提醒：':'Notice: ','错误：':'Error: ','清空执行记录？':'Clear execution history?',
  '将清空全部执行记录，包括当前未显示的记录。任务不受影响。':'All history will be cleared, including hidden records. Tasks are not affected.',
  '清空记录失败，请重试。':'Could not clear history. Please try again.','本次没有清空记录':'No records were cleared',
  '开始看守时间':'Start watching at','继续工作时发送的指令':'Message to continue work','收到 Codex 的明确目标完成确认后，结束看守。':'Watching ends when Codex explicitly confirms the goal is complete.',
  '请选择 Codex 窗口':'Choose a Codex window','未找到已打开的 Codex 窗口':'No open Codex window found',
  '未命名聊天':'Untitled chat','本机聊天':'Local chat','暂无匹配聊天，可直接粘贴深度链接。':'No matching chat. You can paste a deep link.',
  '到点核对额度，尚未恢复会继续等待。':'Usage is checked at the scheduled time; if unavailable, the task waits.',
  '该刷新时间已过，请重新选择或手动调整时间。':'That reset time has passed. Choose another time.',
  '已填入刷新时间；到点仍会核对实际额度。':'Reset time added; actual usage will still be checked.',
  '请填写发送内容或添加图片。':'Enter a message or add an image.','指定聊天':'Specific chat','请先点击“读取当前聊天”，确认所选窗口。':'Select a window and click Read current chat first.',
  '执行时间已过，请选择未来时间后再启用。':'The send time has passed. Choose a future time.',
  '任务已启用':'Task enabled','已保存，尚未启用':'Saved but not enabled','任务已保存，列表暂未刷新，请稍后重试。':'Task saved, but the list could not be refreshed.',
  '暂时没有可用的刷新时间，请稍候同步或手动设置。':'No reset time is available. Wait for sync or set a time manually.',
  '已手动设置时间；到点会核对实际额度。':'Time set manually; actual usage will be checked.',
  '请先打开并选择一个 Codex 窗口。':'Open and select a Codex window first.','当前聊天':'Current chat','当前聊天计划':'Current chat task',
  '调度检查通过，已恢复':'Scheduler checked and resumed','连接检查完成':'Connection check complete','执行记录已导出':'History exported',
  '请选择有效的日期和时间':'Choose a valid date and time','此时间在所选时区不存在，请避开夏令时切换时段':'That time does not exist in the selected time zone. Choose another time.',
  '不限时间':'No time limit','已发送':'Sent','目标完成':'Goal complete','待开始':'Scheduled','待发送':'Scheduled','看守中':'Watching',
  '运行中':'Running','等待额度':'Waiting for usage','等待连接':'Waiting for connection','等待选择':'Waiting for choice','等待确认':'Awaiting confirmation','已到期':'Expired',
  '连接中':'Connecting','正在连接助手':'Connecting to the assistant','连接异常':'Connection error','请从任务栏打开助手':'Open the assistant from the taskbar',
  '调度已停止，请打开助手检查':'Scheduler stopped. Open the assistant to check.','需处理':'Attention','待命':'Idle','暂无待执行任务':'No pending tasks',
  '操作未保存，请重试。':'Changes were not saved. Please retry.','已连接本机 Codex。排队成功仍需等待目标聊天确认。':'Connected to Codex. Queued messages still need confirmation from the target chat.',
  '无法确认登录或额度，请检查 Codex 登录状态后重试。':'Could not verify sign-in or usage. Check Codex and try again.',
  '尚未连接。连接诊断只读取聊天索引和官方额度。':'Not connected. Diagnostics only read the chat index and usage.',
  '正在核对 Codex 登录和额度状态。':'Checking Codex sign-in and usage.',
  '任务已明确启用，等待执行':'Task enabled and waiting to run','任务已暂停':'Task paused','任务尚未启用':'Task is not enabled',
  '目标聊天已收到对应的定时消息':'The scheduled message was received in the target chat.',
  '聊天明确确认约定目标已完成，看守已结束':'Codex confirmed the goal is complete. Watching has ended.',
  '消息已进入队列，正在等待目标聊天确认':'Message queued; waiting for the target chat to confirm it.',
  '消息已进入队列，尚未确认目标聊天开始运行':'Message queued; the target chat has not confirmed it yet.',
  '排队消息尚未得到对应的送达确认，请核实，助手不会重发':'Delivery is unconfirmed. Check the chat; the assistant will not resend.',
  '上次退出时操作尚未确认，请核实聊天后处理，助手不会重发':'The previous action is unconfirmed. Check the chat; it will not be resent.',
  '此前发送的结果尚未核实，助手不会自动重发':'A previous send is unconfirmed. The assistant will not resend.',
  '操作结果待核实，不能重新启用':'The previous action is unconfirmed and cannot be resumed.',
  '操作结果待核实，暂不能删除任务':'The previous action is unconfirmed; this task cannot yet be deleted.',
  '目标聊天正在运行，助手不会追加消息':'The target chat is running; no extra message will be sent.',
  '至少一项额度已用尽，等待恢复并定期重新核对':'A usage limit is exhausted. Waiting and checking again periodically.',
  '官方明确表示普通用量暂不可用；会定期重新读取官方允许状态':'Codex reports that usage is unavailable. The assistant will check again.',
  '此前额度受限，百分比或未知状态不能证明恢复，继续等待官方允许信号':'Usage was limited. Waiting for a fresh confirmation that it is available.',
  '无法确认官方额度允许发送，等待重新核对':'Cannot confirm available usage. Waiting to check again.',
  '聊天请求权限审批，请本人核实并处理':'The chat needs your approval. Review it in Codex.',
  '目标回合已被停止，助手不会替本人重新启动':'The target turn was stopped. The assistant will not restart it automatically.',
  '等待计划执行':'Waiting for the scheduled time','任务已保存，尚未启用':'Task saved but not enabled',
  '聊天正在等待回复':'The chat is waiting for a response.','上次操作结果待核实，已阻止自动重发':'The previous action is unconfirmed; automatic resend is blocked.',
  '重新核对目标回合状态':'Checking the target turn again.','关机或退出期间错过了定时发送；请明确启用后再执行':'The scheduled time was missed while the assistant was closed. Enable the task explicitly to proceed.',
  '截止时间已到，助手已停止干预':'The deadline was reached; the assistant has stopped intervening.',
  '无法可靠识别当前聊天状态':'Cannot reliably identify the chat status.','任务目标记录无效，请重新选择目标':'The task target is invalid. Select the chat again.',
  '等待额度恢复，再重新核对聊天状态':'Waiting for usage to reset before checking the chat.','等待官方额度信息或手工恢复时间':'Waiting for usage information or a manually set reset time.',
  '等待回复的问题无法可靠分类，请本人处理':'Cannot identify the pending question reliably. Please handle it in Codex.',
  '普通问题自动回复已关闭，等待本人回复':'Automatic replies are disabled. Please respond in Codex.',
  '无法区分新的完成回合，已停止自动追加消息':'Cannot distinguish the completed turn; automatic messages have stopped.',
  '同一聊天有另一项操作等待确认，当前任务尚未发送':'Another action in this chat is awaiting confirmation; this task has not sent.',
  '操作意图已保存，等待客户端返回结果':'Action recorded; waiting for the client response.','操作结果无法确认，请核实，助手不会重发':'The result is unconfirmed. Check the chat; the assistant will not resend.',
  '定时消息已确认送达':'The scheduled message was confirmed delivered.','操作已确认提交，继续观察聊天进展':'Action confirmed; continuing to watch the chat.',
  '无法核对所选窗口或目标聊天，已阻止发送':'Cannot verify the target chat. Sending was blocked.','已结束任务不会重新启用，请新建任务':'Completed tasks cannot be re-enabled. Create a new task.',
  '截止时间须晚于当前时间和触发时间':'The deadline must be after both now and the start time.','截止时间已到，请新建或修改任务':'The deadline has passed. Create or edit the task.',
  '操作结果待核实时不能切换目标':'Cannot change the target while an action is unconfirmed.','发送结果待核实时不能更换图片':'Cannot change images while a send is unconfirmed.',
  '仅支持 codex://threads/<UUID> 聊天链接':'Only codex://threads/<UUID> chat links are supported.','请选择目标聊天':'Choose a target chat.',
  '聊天链接无效，请使用 Codex 复制的 codex://threads/UUID 链接':'Invalid chat link. Copy a codex://threads/UUID link from Codex.',
  'Codex 读取连接已断开，下一次检查会尝试重新建立读取连接。':'The Codex connection was lost. The next check will reconnect.',
  '聊天记录仍在写入或正在补全读取，稍后重新核对；尚未发送消息':'Chat history is still being written or read. The assistant will check again; no message was sent.',
  '无法完整核对聊天的运行、停止和完成记录，已阻止自动发送':'Cannot fully verify the chat status; automatic sending was blocked.',
  '最新持久回合状态显示仍在运行，助手不会追加消息':'The latest turn is still running; no extra message will be sent.',
  '此前已遇到额度限制，当前无法获得新鲜的官方允许信号':'Usage was limited and a fresh approval is unavailable. Waiting.',
  '无法读取官方额度，暂不进行自动发送':'Cannot read usage; automatic sending is paused.','已取得新鲜的官方普通用量允许信号，可继续先前因额度停止的回合':'Fresh usage approval received; the previously limited turn can continue.',
  '发送阶段发生错误，操作可能已经入队，助手不会重发，请在目标聊天核实':'An error occurred during sending. The message may be queued; check the chat. It will not be resent automatically.',
  '发送前核对未通过，未提交消息':'Pre-send checks failed; no message was submitted.','所选窗口的当前聊天已经切换，已阻止发送':'The selected window changed chats; sending was blocked.',
  '排队请求发出后未取得可核实结果；可能已经入队，助手不会重发，请在原聊天核实':'The queue result is unconfirmed. Check the original chat; the message will not be resent automatically.',
  '队列响应缺少匹配的提交凭据，助手不会重发，请在目标聊天核实':'The queue response could not be verified. Check the chat; the assistant will not resend.',
  '持久记录明确显示目标回合仍在运行':'The target turn is still running.','目标回合明确遇到额度限制，等待新鲜的官方允许信号':'The target turn reached a usage limit. Waiting for fresh approval.',
  '持久记录明确显示该回合已完成，项目是否完成仍按约定判断':'The turn is complete. The agreed goal still needs explicit confirmation.',
  '目标聊天正在请求权限审批，请本人处理':'The chat needs your approval. Please review it in Codex.','目标聊天存在尚未解决的普通选择题':'The chat has an unanswered choice. Please respond in Codex.',
  '当前客户端无法可靠识别所需状态，请手工处理':'The current client state cannot be identified reliably. Check it manually.',
  '网络连接暂不可用，等待重新读取':'Connection unavailable. Waiting to check again.',
  '没有找到可用的 Codex CLI。请先安装并登录 Codex，或在设置中选择 codex.exe':'Codex CLI was not found. Install and sign in to Codex, or select codex.exe in Settings.',
  '当前桌面连接没有可验证的待答请求提交接口。请在 Codex 中处理普通选择题；看守消息会预先附带决策规则，但无法解除已经阻塞的问题。':'This connection cannot answer an already-open choice. Please handle it in Codex.',
  '显示倒计时悬浮球':'Show floating timer','打开助手':'Open assistant','打开 Codex 定时助手':'Open Codex Timer Assistant',
  '恢复全部任务':'Resume all tasks','关闭悬浮球':'Hide floating timer','退出助手':'Quit assistant','退出':'Quit',
});

let language = 'zh-CN';
export const englishMessages = en;
export function resolveLanguage(preference = 'system', system = 'zh-CN') {
  const value = preference === 'system' ? system : preference;
  return String(value || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
export function setLanguage(preference, system = 'zh-CN') { language = resolveLanguage(preference, system); return language; }
export function currentLanguage() { return language; }
export function tr(source) { return language === 'en' && Object.hasOwn(en, source) ? en[source] : source; }
export function systemMessage(source) {
  if (typeof source !== 'string' || language !== 'en') return source;
  if (Object.hasOwn(en, source)) return en[source];
  return /[\u3400-\u9fff]/u.test(source) ? `Details (Chinese): ${source}` : source;
}

// Capture only initial, app-authored markup; dynamic user content is excluded.
export function captureStaticTranslations(doc) {
  const texts = [], attributes = [];
  const walker = doc.createTreeWalker(doc.documentElement, 4);
  while (walker.nextNode()) {
    const node = walker.currentNode, source = node.nodeValue;
    if (/[\u3400-\u9fff]/u.test(source) && !['SCRIPT', 'STYLE', 'CODE'].includes(node.parentElement?.tagName)) texts.push({node,source});
  }
  for (const element of doc.querySelectorAll('[title],[aria-label],[placeholder]')) {
    for (const name of ['title','aria-label','placeholder']) {
      const source = element.getAttribute(name);
      if (source && /[\u3400-\u9fff]/u.test(source)) attributes.push({element,name,source});
    }
  }
  return () => {
    doc.documentElement.lang = language;
    for (const {node,source} of texts) if (node.isConnected) {
      const match = source.match(/^(\s*)([\s\S]*?)(\s*)$/u);
      node.nodeValue = match[1] + tr(match[2]) + match[3];
    }
    for (const {element,name,source} of attributes) if (element.isConnected) element.setAttribute(name,tr(source));
  };
}
