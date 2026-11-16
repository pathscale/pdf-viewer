use pdf_toolkit::core::{ObjectRef, ValueKind, ValueRef};

pub(super) fn visit_refs(
    value: ValueRef<'_>,
    remaining: &mut u64,
    max_depth: u32,
    on_ref: impl FnMut(ObjectRef) -> Result<(), String>,
) -> Result<(), String> {
    let mut on_ref = on_ref;
    visit(value, remaining, max_depth, 0, &mut on_ref)
}

fn visit(
    value: ValueRef<'_>,
    remaining: &mut u64,
    max_depth: u32,
    container_depth: u32,
    on_ref: &mut impl FnMut(ObjectRef) -> Result<(), String>,
) -> Result<(), String> {
    if *remaining == 0 {
        return Err("refused: rewrite_values, requested=1, maximum=0".to_owned());
    }
    *remaining -= 1;

    match value.kind() {
        ValueKind::Array => {
            let depth = container_depth
                .checked_add(1)
                .ok_or_else(|| "PDF rewrite value depth exceeds configured limit".to_owned())?;
            if depth > max_depth {
                return Err("PDF rewrite value depth exceeds configured limit".to_owned());
            }
            let array = value
                .as_array()
                .ok_or_else(|| "PDF array value is invalid".to_owned())?;
            for item in array.iter() {
                visit(item, remaining, max_depth, depth, on_ref)?;
            }
        }
        ValueKind::Dict => {
            let depth = container_depth
                .checked_add(1)
                .ok_or_else(|| "PDF rewrite value depth exceeds configured limit".to_owned())?;
            if depth > max_depth {
                return Err("PDF rewrite value depth exceeds configured limit".to_owned());
            }
            let dictionary = value
                .as_dict()
                .ok_or_else(|| "PDF dictionary value is invalid".to_owned())?;
            for (_, item) in dictionary.iter() {
                visit(item, remaining, max_depth, depth, on_ref)?;
            }
        }
        ValueKind::Ref => {
            let id = value
                .as_ref()
                .ok_or_else(|| "PDF reference value is invalid".to_owned())?;
            on_ref(id)?;
        }
        _ => {}
    }
    Ok(())
}
