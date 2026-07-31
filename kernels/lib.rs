#![cfg_attr(target_arch = "wasm32", no_std)]

const CAPACITY: usize = 2 * 1024 * 1024;
static mut BUFFER: [u8; CAPACITY] = [0; CAPACITY];

fn contains(line: &[u8], needle: &[u8]) -> bool {
    needle.is_empty()
        || (needle.len() <= line.len() && line.windows(needle.len()).any(|part| part == needle))
}

fn filter(
    buffer: &mut [u8],
    source_len: usize,
    needle_at: usize,
    needle_len: usize,
    invert: bool,
) -> usize {
    if source_len > needle_at
        || needle_at
            .checked_add(needle_len)
            .is_none_or(|end| end > buffer.len())
    {
        return 0;
    }
    let mut read = 0;
    let mut written = 0;
    while read < source_len {
        let end = buffer[read..source_len]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(source_len, |offset| read + offset + 1);
        let body_end = end - usize::from(buffer[end.saturating_sub(1)] == b'\n');
        let matched = contains(
            &buffer[read..body_end],
            &buffer[needle_at..needle_at + needle_len],
        ) ^ invert;
        if matched {
            for index in read..end {
                buffer[written] = buffer[index];
                written += 1;
            }
        }
        read = end;
    }
    written
}

#[unsafe(no_mangle)]
pub extern "C" fn abi() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn buffer_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(BUFFER).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn capacity() -> usize {
    CAPACITY
}

#[unsafe(no_mangle)]
pub extern "C" fn filter_lines(
    source_len: usize,
    needle_at: usize,
    needle_len: usize,
    invert: u32,
) -> usize {
    // SAFETY: the exported bounds are checked before the single static buffer is borrowed.
    unsafe {
        filter(
            &mut *core::ptr::addr_of_mut!(BUFFER),
            source_len,
            needle_at,
            needle_len,
            invert != 0,
        )
    }
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}

#[cfg(test)]
mod tests {
    use super::filter;

    #[test]
    fn filters_complete_and_final_lines() {
        let mut data = [0_u8; 64];
        let source = b"koala\n dingo\nkoala";
        let needle = b"koala";
        data[..source.len()].copy_from_slice(source);
        data[source.len()..source.len() + needle.len()].copy_from_slice(needle);
        let length = filter(&mut data, source.len(), source.len(), needle.len(), false);
        assert_eq!(&data[..length], b"koala\nkoala");
    }
}
