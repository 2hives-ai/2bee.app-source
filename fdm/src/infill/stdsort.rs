//! Bit-exact port of libstdc++ `std::sort` (introsort + final insertion sort). `connect_infill` sorts boundary arcs
//! with `std::sort` and many arcs have EQUAL length on regular infill, so the order of the ties (which libstdc++'s
//! unstable sort decides) selects which lines get joined. Rust's `sort_by` is stable and would pick differently.

const THRESHOLD: usize = 16;

/// `std::sort(v.begin(), v.end(), less)`; `less(a, b)` is the strict weak ordering.
pub fn std_sort<T: Clone, F: FnMut(&T, &T) -> bool>(v: &mut [T], mut less: F) {
    let n = v.len();
    if n < 2 { return; }
    let depth = 2 * (usize::BITS - 1 - n.leading_zeros()) as usize;
    introsort_loop(v, 0, n, depth, &mut less);
    final_insertion_sort(v, &mut less);
}

fn move_median_to_first<T, F: FnMut(&T, &T) -> bool>(v: &mut [T], result: usize, a: usize, b: usize, c: usize, less: &mut F) {
    if less(&v[a], &v[b]) {
        if less(&v[b], &v[c]) { v.swap(result, b); }
        else if less(&v[a], &v[c]) { v.swap(result, c); }
        else { v.swap(result, a); }
    } else if less(&v[a], &v[c]) { v.swap(result, a); }
    else if less(&v[b], &v[c]) { v.swap(result, c); }
    else { v.swap(result, b); }
}

fn unguarded_partition<T, F: FnMut(&T, &T) -> bool>(v: &mut [T], mut first: usize, mut last: usize, pivot: usize, less: &mut F) -> usize {
    loop {
        while less(&v[first], &v[pivot]) { first += 1; }
        last -= 1;
        while less(&v[pivot], &v[last]) { last -= 1; }
        if !(first < last) { return first; }
        v.swap(first, last);
        first += 1;
    }
}

fn introsort_loop<T: Clone, F: FnMut(&T, &T) -> bool>(v: &mut [T], first: usize, mut last: usize, mut depth: usize, less: &mut F) {
    while last - first > THRESHOLD {
        if depth == 0 {
            heap_sort(&mut v[first..last], less);
            return;
        }
        depth -= 1;
        let mid = first + (last - first) / 2;
        move_median_to_first(v, first, first + 1, mid, last - 1, less);
        let cut = unguarded_partition(v, first + 1, last, first, less);
        introsort_loop(v, cut, last, depth, less);
        last = cut;
    }
}

fn unguarded_linear_insert<T: Clone, F: FnMut(&T, &T) -> bool>(v: &mut [T], mut last: usize, less: &mut F) {
    let val = v[last].clone();
    while less(&val, &v[last - 1]) { v[last] = v[last - 1].clone(); last -= 1; }
    v[last] = val;
}

fn insertion_sort<T: Clone, F: FnMut(&T, &T) -> bool>(v: &mut [T], first: usize, last: usize, less: &mut F) {
    if first == last { return; }
    for i in first + 1..last {
        if less(&v[i], &v[first]) {
            let val = v[i].clone();
            for k in (first..i).rev() { v[k + 1] = v[k].clone(); }
            v[first] = val;
        } else { unguarded_linear_insert(v, i, less); }
    }
}

fn final_insertion_sort<T: Clone, F: FnMut(&T, &T) -> bool>(v: &mut [T], less: &mut F) {
    let n = v.len();
    if n > THRESHOLD {
        insertion_sort(v, 0, THRESHOLD, less);
        for i in THRESHOLD..n { unguarded_linear_insert(v, i, less); }
    } else { insertion_sort(v, 0, n, less); }
}

/// `std::partial_sort(first, last, last)` = make_heap + sort_heap (only reached on pathological input).
fn heap_sort<T: Clone, F: FnMut(&T, &T) -> bool>(v: &mut [T], less: &mut F) {
    let n = v.len();
    fn sift<T: Clone, F: FnMut(&T, &T) -> bool>(v: &mut [T], mut hole: usize, len: usize, val: T, less: &mut F) {
        let top = hole;
        let mut child = hole;
        while child < (len.saturating_sub(1)) / 2 {
            child = 2 * (child + 1);
            if less(&v[child], &v[child - 1]) { child -= 1; }
            v[hole] = v[child].clone();
            hole = child;
        }
        if len & 1 == 0 && child == (len - 2) / 2 {
            child = 2 * (child + 1);
            v[hole] = v[child - 1].clone();
            hole = child - 1;
        }
        // push_heap
        let mut parent = if hole > top { (hole - 1) / 2 } else { 0 };
        while hole > top && less(&v[parent], &val) {
            v[hole] = v[parent].clone();
            hole = parent;
            parent = if hole > 0 { (hole - 1) / 2 } else { 0 };
        }
        v[hole] = val;
    }
    if n >= 2 {
        let mut parent = (n - 2) / 2;
        loop {
            let val = v[parent].clone();
            sift(v, parent, n, val, less);
            if parent == 0 { break; }
            parent -= 1;
        }
    }
    let mut last = n;
    while last > 1 {
        last -= 1;
        let val = v[last].clone();
        v[last] = v[0].clone();
        sift(v, 0, last, val, less);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sorts_like_a_sort() {
        let mut s = 12345u64;
        for n in [0usize, 1, 2, 5, 16, 17, 40, 200, 1000] {
            let mut v: Vec<(u32, usize)> = (0..n).map(|i| { s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((s >> 40) as u32 % 7, i) }).collect();
            std_sort(&mut v, |a, b| a.0 < b.0);
            assert!(v.windows(2).all(|w| w[0].0 <= w[1].0), "n={n}");
        }
    }
    #[test]
    fn heap_path_sorts() {
        let mut v: Vec<u32> = (0..50).rev().collect();
        heap_sort(&mut v, &mut |a: &u32, b: &u32| a < b);
        assert!(v.windows(2).all(|w| w[0] <= w[1]));
    }
}
