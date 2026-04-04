//! Утилита обрабатывает `jpeg`/`jpg`/`png` в каталоге исполняемого файла.
//! Длинная сторона больше [`MAX_LONG_EDGE`] — даунскейл с сохранением пропорций, перекодирование
//! (JPEG с [`QUALITY`]), перезапись того же файла. Уже влезающие в лимит пропускаются.
//! При несовпадении содержимого и расширения файл переименовывается в `err_*`.

use std::env;
use std::fs;
use std::io::{self, BufRead, Cursor, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, GenericImageView, ImageFormat};

use tracing_subscriber::EnvFilter;

const MAX_LONG_EDGE: u32 = 1920;
const QUALITY: u8 = 85;

fn stderr_use_ansi_colors() -> bool {
    if env::var_os("NO_COLOR").is_some() {
        return false;
    }
    let stderr = io::stderr();
    if !stderr.is_terminal() {
        return false;
    }
    #[cfg(windows)]
    {
        env::var_os("WT_SESSION").is_some()
            || env::var_os("ANSICON").is_some()
            || env::var_os("TERM").is_some()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_ansi(stderr_use_ansi_colors())
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let exit_code = match run() {
        Ok(()) => 0,
        Err(e) => {
            tracing::error!(error = %e, "ошибка выполнения");
            1
        }
    };

    pause_console_on_windows_if_interactive();
    process::exit(exit_code);
}

#[cfg(windows)]
fn pause_console_on_windows_if_interactive() {
    if env::var_os("CONVERTER_NO_WAIT").is_some() {
        return;
    }

    let stdin = io::stdin();
    if !stdin.is_terminal() {
        return;
    }

    let mut stderr = io::stderr();
    let _ = writeln!(stderr, "\nНажмите Enter, чтобы закрыть окно…");
    let _ = stdin.lock().read_line(&mut String::new());
}

#[cfg(not(windows))]
fn pause_console_on_windows_if_interactive() {}

const IMAGE_EXTENSIONS: &[&str] = &["jpeg", "jpg", "png"];

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|&known| known.eq_ignore_ascii_case(ext))
        })
}

fn image_format_from_path(path: &Path) -> io::Result<ImageFormat> {
    let ext = path.extension().and_then(|e| e.to_str()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "у файла нет расширения — неизвестно, в какой формат кодировать",
        )
    })?;
    image_format_from_extension(ext)
}

fn image_format_from_extension(ext: &str) -> io::Result<ImageFormat> {
    if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
        Ok(ImageFormat::Jpeg)
    } else if ext.eq_ignore_ascii_case("png") {
        Ok(ImageFormat::Png)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "расширение .{ext} не сопоставлено с ImageFormat (добавьте ветку при необходимости)"
            ),
        ))
    }
}

fn read_image_with_format(path: &Path) -> io::Result<(DynamicImage, ImageFormat)> {
    let format = image_format_from_path(path)?;
    let bytes = fs::read(path)?;
    let image = image::load_from_memory_with_format(&bytes, format).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("содержимое не совпадает с форматом по расширению ({format:?}): {e}"),
        )
    })?;
    Ok((image, format))
}

fn is_decode_extension_mismatch(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::InvalidData
        && err
            .to_string()
            .contains("содержимое не совпадает с форматом по расширению")
}

fn rename_to_err_prefixed(path: &Path) -> io::Result<PathBuf> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let orig_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "у пути нет имени файла")
    })?;
    let orig_str = orig_name.to_string_lossy();

    let mut n = 0u32;
    loop {
        let new_file_name = if n == 0 {
            format!("err_{orig_str}")
        } else {
            format!("err_{n}_{orig_str}")
        };
        let dest = parent.join(&new_file_name);
        if !dest.exists() {
            fs::rename(path, &dest)?;
            return Ok(dest);
        }
        n += 1;
        if n > 10_000 {
            return Err(io::Error::other(
                "не удалось подобрать свободное имя err_* для переименования",
            ));
        }
    }
}

fn image_fits_max_long_edge(image: &DynamicImage) -> bool {
    let (w, h) = image.dimensions();
    w.max(h) <= MAX_LONG_EDGE
}

fn resize_preserving_aspect(image: DynamicImage) -> DynamicImage {
    let (width, height) = image.dimensions();
    let current_long_edge = width.max(height);

    let ratio = MAX_LONG_EDGE as f32 / current_long_edge as f32;
    let new_width = (width as f32 * ratio).round().max(1.0) as u32;
    let new_height = (height as f32 * ratio).round().max(1.0) as u32;

    image.resize_exact(new_width, new_height, FilterType::Lanczos3)
}

fn encode_preserving_format(image: &DynamicImage, format: ImageFormat) -> io::Result<Vec<u8>> {
    let (width, height) = image.dimensions();
    let pixels = (width as usize).saturating_mul(height as usize);
    let initial_capacity = match format {
        ImageFormat::Jpeg => pixels.saturating_mul(3) / 8,
        _ => pixels.saturating_mul(2),
    }
    .max(8 * 1024);
    let mut output = Vec::with_capacity(initial_capacity);
    match format {
        ImageFormat::Jpeg => {
            let mut cursor = Cursor::new(&mut output);
            let rgb8 = image.to_rgb8();
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, QUALITY);
            encoder
                .encode(rgb8.as_raw(), width, height, ColorType::Rgb8.into())
                .map_err(|e| io::Error::other(format!("jpeg encode: {e}")))?;
        }
        _ => {
            image
                .write_to(&mut Cursor::new(&mut output), format)
                .map_err(|e| io::Error::other(format!("encode: {e}")))?;
        }
    }
    Ok(output)
}

fn run() -> io::Result<()> {
    tracing::info!("старт: определение пути к исполняемому файлу");

    let exe = env::current_exe()?;
    tracing::info!(path = %exe.display(), "получен путь к exe");

    tracing::info!("определение каталога рядом с exe");
    let dir = exe.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "у пути к исполняемому файлу нет родительской директории",
        )
    })?;
    tracing::info!(dir = %dir.display(), "каталог для сканирования");

    tracing::info!("чтение содержимого каталога");
    let mut names: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter(|e| is_image_file(&e.path()))
        .map(|e| e.file_name())
        .collect();

    tracing::info!(count = names.len(), "отобраны только файлы-изображения");

    tracing::info!("сортировка имён");
    names.sort();

    let mut skipped_already_small = 0u32;
    let mut processed_ok = 0u32;
    let mut corrupt_renamed = 0u32;

    for name in &names {
        let file_label = name.to_string_lossy();
        let path = dir.join(name);

        tracing::info!(file = %file_label, "файл в очереди");
        let (image, format) = match read_image_with_format(&path) {
            Ok(v) => v,
            Err(e) if is_decode_extension_mismatch(&e) => {
                match rename_to_err_prefixed(&path) {
                    Ok(new_path) => {
                        corrupt_renamed += 1;
                        tracing::warn!(
                            from = %file_label,
                            to = %new_path.display(),
                            error = %e,
                            "битое содержимое: переименовано с префиксом err_, обработка пропущена"
                        );
                    }
                    Err(re) => {
                        tracing::error!(
                            file = %file_label,
                            decode_err = %e,
                            rename_err = %re,
                            "не удалось переименовать битый файл"
                        );
                        return Err(re);
                    }
                }
                continue;
            }
            Err(e) => return Err(e),
        };
        tracing::debug!(file = %file_label, ?format, "прочитан");

        if image_fits_max_long_edge(&image) {
            let (w, h) = image.dimensions();
            let long_edge = w.max(h);
            skipped_already_small += 1;
            tracing::info!(
                file = %file_label,
                width = w,
                height = h,
                long_edge,
                limit = MAX_LONG_EDGE,
                "СКИП: длинная сторона ≤ лимита, перезапись не нужна"
            );
            continue;
        }

        let (w_in, h_in) = image.dimensions();
        tracing::info!(
            file = %file_label,
            width_in = w_in,
            height_in = h_in,
            long_in = w_in.max(h_in),
            limit = MAX_LONG_EDGE,
            ?format,
            "ОБРАБОТКА: даунскейл и перекодирование"
        );

        let resized_image = resize_preserving_aspect(image);
        let (w_out, h_out) = resized_image.dimensions();

        let encoded_image = encode_preserving_format(&resized_image, format)?;
        let out_bytes = encoded_image.len();
        fs::write(&path, encoded_image)?;

        processed_ok += 1;
        tracing::info!(
            file = %file_label,
            width_out = w_out,
            height_out = h_out,
            long_out = w_out.max(h_out),
            out_bytes,
            "ГОТОВО: перезаписан на диске"
        );
    }

    tracing::info!(
        candidates = names.len(),
        skipped_small = skipped_already_small,
        processed = processed_ok,
        corrupt_renamed,
        "итог: кандидатов, скип по размеру, обработано, переименовано битых (err_*)"
    );
    Ok(())
}
