pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|panic_info| {
        let location = panic_info
            .location()
            .map(|location| format!("{}:{}:{}", location.file(), location.line(), location.column()))
            .unwrap_or_else(|| "unknown".to_string());

        let message = if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
            (*message).to_string()
        } else if let Some(message) = panic_info.payload().downcast_ref::<String>() {
            message.clone()
        } else {
            "未知 panic".to_string()
        };

        log::error!("[panic] {} @ {}", message, location);
        ::std::eprintln!("[panic] {} @ {}", message, location);
    }));
}

#[macro_export]
macro_rules! println {
    ($($arg:tt)*) => {{
        ::log::info!($($arg)*);
        ::std::println!($($arg)*);
    }};
}

#[macro_export]
macro_rules! eprintln {
    ($($arg:tt)*) => {{
        ::log::error!($($arg)*);
        ::std::eprintln!($($arg)*);
    }};
}