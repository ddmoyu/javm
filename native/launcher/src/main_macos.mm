#import <AppKit/AppKit.h>
#include <string>

// LaunchServices 把 javm:// 作为 Apple Event 交给 APP 主进程。
// 常驻的轻量入口仅接收事件、监督官方宿主，并用新宿主的官方 Extension
// 单实例队列转交请求；不增加自定义 IPC 或业务服务器。
@interface JAVMLauncher : NSObject <NSApplicationDelegate>
@property(nonatomic, copy) NSString* host;
@property(nonatomic, copy) NSArray<NSString*>* arguments;
@property(nonatomic, strong) NSMutableArray<NSString*>* pendingURLs;
@property(nonatomic, strong) NSMutableSet<NSTask*>* children;
@property(nonatomic, strong) NSTask* primary;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL stopping;
@property(nonatomic) int result;
@end

@implementation JAVMLauncher
- (NSTask*)launch:(NSArray<NSString*>*)arguments secondary:(BOOL)secondary {
    if(self.stopping || self.children.count >= 16) return nil;
    NSTask* task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:self.host];
    task.currentDirectoryURL = [NSURL fileURLWithPath:[self.host stringByDeletingLastPathComponent] isDirectory:YES];
    task.arguments = arguments;
    __weak JAVMLauncher* weakSelf = self;
    task.terminationHandler = ^(NSTask* completed) {
        dispatch_async(dispatch_get_main_queue(), ^{
            JAVMLauncher* strongSelf = weakSelf;
            if(!strongSelf) return;
            [strongSelf.children removeObject:completed];
            if(completed == strongSelf.primary) {
                strongSelf.result = completed.terminationStatus;
                [NSApp terminate:nil];
            }
        });
    };
    NSError* error = nil;
    if(![task launchAndReturnError:&error]) {
        if(!secondary) { self.result = 1; [NSApp terminate:nil]; }
        return nil;
    }
    [self.children addObject:task];
    if(secondary) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if(task.running) [task terminate];
    });
    return task;
}
- (void)applicationDidFinishLaunching:(NSNotification*)notification {
    (void)notification;
    NSMutableArray<NSString*>* args = [self.arguments mutableCopy];
    [args addObjectsFromArray:self.pendingURLs];
    [self.pendingURLs removeAllObjects];
    self.started = YES;
    self.primary = [self launch:args secondary:NO];
}
- (void)application:(NSApplication*)application openURLs:(NSArray<NSURL*>*)urls {
    (void)application;
    NSMutableArray<NSString*>* values = [NSMutableArray array];
    for(NSURL* url in urls) {
        NSString* value = url.absoluteString;
        if([url.scheme.lowercaseString isEqualToString:@"javm"] && value.length <= 8192 && values.count < 16)
            [values addObject:value];
    }
    if(!values.count) return;
    if(!self.started) {
        for(NSString* value in values) if(self.pendingURLs.count < 16) [self.pendingURLs addObject:value];
    } else {
        NSMutableArray* args = [NSMutableArray arrayWithObject:@"--window-hidden"];
        [args addObjectsFromArray:values];
        [self launch:args secondary:YES];
    }
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
    (void)sender;
    self.stopping = YES;
    for(NSTask* child in self.children) if(child.running) [child terminate];
    return NSTerminateNow;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender {
    (void)sender; return NO;
}
@end

int javmMacApplication(int argc, char* argv[], const std::string& host) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        JAVMLauncher* delegate = [[JAVMLauncher alloc] init];
        delegate.host = [[NSString alloc] initWithBytes:host.data() length:host.size() encoding:NSUTF8StringEncoding];
        NSMutableArray* arguments = [NSMutableArray array];
        for(int i = 1; i < argc; ++i) {
            NSString* value = [NSString stringWithUTF8String:argv[i]];
            if(!value) return 2;
            [arguments addObject:value];
        }
        delegate.arguments = arguments;
        delegate.pendingURLs = [NSMutableArray array];
        delegate.children = [NSMutableSet set];
        NSApp.delegate = delegate;
        [NSApp run];
        return delegate.result;
    }
}
