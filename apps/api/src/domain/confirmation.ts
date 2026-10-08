export function isConfirmation(text: string): boolean {
  const message = text.trim();
  if (
    /[?？]|(?:吗|么|呢)[。！!\s]*$|(?:不要|别|不)(?:执行|下载|提交|推送)|取消|暂停|暂缓|稍后|等等/.test(
      message,
    )
  ) {
    return false;
  }
  return /^(?:确认(?:$|[。！!\s]|执行|下载|订阅|操作|提交|推送)|(?:立即|现在|直接|马上|继续)?(?:执行|提交|推送)|confirm\b)/i.test(
    message,
  );
}
